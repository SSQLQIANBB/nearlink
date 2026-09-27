import { RemoteControlService } from './remoteControlService';
import { RedisRemoteSessionStore, type RemoteRevocationJob } from './redisRemoteSessionStore';
import { RemoteSessionHistory } from './remoteSessionHistory';
import { REMOTE_HISTORY_RETENTION_MS, REMOTE_HISTORY_CLEANUP_INTERVAL_MS } from './remoteControlRetention';
import { onLoginSessionsRevoked, type SessionRevocation } from './loginSessionService';
import { endRemoteSession, RemoteControlError, type RemoteSession } from './remoteControlProtocol';

type RuntimeHistory = Pick<RemoteSessionHistory, 'archiveEnd' | 'incomplete' | 'markInterrupted' | 'assertAuthorized' | 'revokeGrants' | 'pruneTerminal'>;
export interface RemoteRuntimeOptions {
  batchSize?: number;
  intervalMs?: number;
  now?: () => number;
  subscribe?: typeof onLoginSessionsRevoked;
  reportError?: (phase: string, error: unknown) => void;
}

/** One backend owns the runtime. All scans and retry queues have bounded work per tick. */
export class RemoteControlRuntime {
  private timer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  private running?: Promise<void>;
  private stopping?: Promise<void>;
  private stopped = false;
  private recovering = false;
  private reconcileAfter: string | null = null;
  private retentionAfter: string | null = null;
  private nextRetentionAt = 0;
  private readonly batch: number;
  private readonly now: () => number;
  constructor(readonly service: RemoteControlService, private readonly store: RedisRemoteSessionStore,
    private readonly history: RuntimeHistory, private readonly options: RemoteRuntimeOptions = {}) {
    this.batch = Math.max(1, Math.min(100, options.batchSize || 25));
    this.now = options.now || Date.now;
  }
  private report(phase: string, error: unknown) {
    if (this.options.reportError) this.options.reportError(phase, error);
    else console.error('remote_runtime_failed', { phase, type: error instanceof Error ? error.name : 'UnknownError' });
  }
  start() {
    if (this.timer || this.stopped) return;
    this.recovering = true;
    this.service.pauseAdmissionForRecovery();
    this.unsubscribe = (this.options.subscribe || onLoginSessionsRevoked)(event => this.revoke(event));
    this.timer = setInterval(() => { void this.tick(); }, Math.max(100, this.options.intervalMs || 1000));
    this.timer.unref();
    void this.tick();
  }
  async revoke(event: SessionRevocation) {
    if (this.stopped) return;
    try {
      await this.store.enqueueRevocation(event, this.now());
      // Close a bounded batch immediately without waiting for audit/grant SQL writes.
      await this.processRevocations(false);
    } catch (error) { this.report('revoke', error); }
  }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    const task = (async () => {
      for (const [name, operation] of [
        ['startup', () => this.recoverPriorProcess()], ['timeouts', () => this.expireDue()], ['revocations', () => this.processRevocations(true)],
        ['history', () => this.archiveOutbox()], ['reconcile', () => this.reconcile()], ['retention', () => this.pruneHistory()],
      ] as const) {
        if (this.stopped) break;
        try { await operation(); } catch (error) { this.report(name, error); }
      }
    })().finally(() => { if (this.running === task) this.running = undefined; });
    this.running = task;
    return task;
  }
  private async recoverPriorProcess() {
    if (!this.recovering) return;
    // Connection identities belong to the old process. Never inherit active authorization.
    const ids = await this.store.indexedSessions(null, this.batch);
    for (const id of ids) {
      const session = await this.store.get(id);
      if (!session || session.state === 'ended') await this.store.removeStaleIndex(null, id);
      else await this.service.end(id, 'SERVER_RESTART');
    }
    if (ids.length < this.batch) {
      this.recovering = false;
      this.service.finishRecovery();
    }
  }
  private async expireDue() {
    const cutoff = this.now();
    for (const id of await this.store.due(cutoff, this.batch)) {
      const current = await this.store.get(id);
      if (!current || current.state === 'ended') { await this.store.removeDeadline(id, cutoff); continue; }
      // A ready/accept transition may have extended the deadline since the sorted-set read.
      if (current.deadline > cutoff && current.hardDeadline > cutoff) continue;
      // End with CAS against exactly the expired revision, not a reloaded/extended revision.
      try {
        this.service.publishCommitted(await this.store.save(current, endRemoteSession(current, 'EXPIRED', cutoff), cutoff));
      } catch (error) {
        if (!(error instanceof RemoteControlError) || !['REVISION_CONFLICT', 'SESSION_ENDED', 'SESSION_NOT_FOUND'].includes(error.code)) throw error;
      }
    }
  }
  private async processRevocations(finalizeGrants: boolean) {
    for (const entry of await this.store.readRevocations(this.now(), Math.min(4, this.batch))) {
      const event = JSON.parse(entry.raw) as RemoteRevocationJob;
      const ids = await this.store.indexedSessions(event, this.batch);
      for (const id of ids) {
        const session = await this.store.get(id);
        if (!session) { await this.store.removeStaleIndex(event, id); continue; }
        const involved = event.sid
          ? [session.controller.sid, session.host.sid, session.grantCreatedBySid].includes(event.sid)
          : [session.controller, session.host].some(identity => identity.userId === event.userId
            && (!event.revokedAuthVersion || identity.authVersion === event.revokedAuthVersion));
        if (involved && session.state !== 'ended') await this.service.end(id, 'AUTH_REVOKED');
      }
      if (ids.length >= this.batch) {
        await this.store.advanceRevocation(entry, ids[ids.length - 1]);
      } else if (finalizeGrants) {
        try {
          await this.history.revokeGrants(event);
          await this.store.acknowledgeRevocation(entry);
        } catch (error) { await this.store.deferRevocation(entry, this.now() + 5000); this.report('revoke-grants', error); }
      }
    }
  }
  private async archiveOutbox() {
    for (const entry of await this.store.readOutbox(this.now(), this.batch)) {
      try {
        const terminal = JSON.parse(entry.raw) as RemoteSession;
        if (terminal.id !== entry.id) throw new RemoteControlError('INVALID_TERMINAL_EVENT');
        await this.history.archiveEnd(terminal);
        // Another writer cannot lose a newer event while this SQL transaction was pending.
        await this.store.acknowledgeHistory(entry.id, entry.raw);
      } catch (error) {
        await this.store.deferHistory(entry.id, entry.raw, this.now() + 5000);
        this.report('archive', error);
        break;
      }
    }
  }
  private async reconcile() {
    // Admission can live at most 45 seconds. The grace period excludes in-flight prepare/create.
    const records = await this.history.incomplete(this.reconcileAfter, new Date(this.now() - 60_000), this.batch);
    for (const record of records) {
      const live = await this.store.get(record.sessionId); // Redis errors are never interpreted as absence.
      if (!live) {
        await this.store.cleanupOrphan(record);
        await this.history.markInterrupted(record.sessionId);
      }
      else if (live.state !== 'ended') {
        try { await this.history.assertAuthorized(live); }
        catch (error) {
          // Database outages are not durable revocation evidence. Lease issuance also fails closed.
          if (error instanceof RemoteControlError && ['AUTH_REVOKED', 'TARGET_UNAVAILABLE'].includes(error.code)) {
            await this.service.end(live.id, 'AUTH_REVOKED');
          } else throw error;
        }
      }
      this.reconcileAfter = record.sessionId;
    }
    if (records.length < this.batch) this.reconcileAfter = null;
  }
  private async pruneHistory() {
    const now = this.now();
    if (now < this.nextRetentionAt) return;
    const result = await this.history.pruneTerminal(new Date(now - REMOTE_HISTORY_RETENTION_MS),
      this.retentionAfter, this.batch, id => this.store.canPruneHistory(id));
    if (result.scanned >= this.batch) this.retentionAfter = result.afterId;
    else {
      this.retentionAfter = null;
      this.nextRetentionAt = now + REMOTE_HISTORY_CLEANUP_INTERVAL_MS;
    }
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.service.stopAdmission();
    clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe?.(); this.unsubscribe = undefined;
    this.stopping = (async () => {
      // Each Redis operation is bounded. The app has a separate shutdown deadline.
      for (;;) {
        const ids = await this.store.indexedSessions(null, this.batch);
        if (!ids.length) break;
        for (const id of ids) {
          const current = await this.store.get(id);
          if (!current || current.state === 'ended') await this.store.removeStaleIndex(null, id);
          else await this.service.end(id, 'SERVER_SHUTDOWN');
        }
        if (ids.length < this.batch) break;
      }
      await this.running;
      // Best effort bounded flush; remaining atomic outbox entries survive for the next process.
      await this.archiveOutbox();
    })().catch(error => { this.report('stop', error); });
    return this.stopping;
  }
}

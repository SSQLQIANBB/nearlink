import { randomUUID } from 'crypto';
import type { RemoteHistoryWriter } from './remoteSessionHistory';
import {
  endRemoteSession, isEndpoint, REMOTE_LIMITS, RemoteControlError, remoteDigest, transitionRemoteSession,
  type RemoteAction, type RemoteEndpoint, type RemoteScope, type RemoteSession,
} from './remoteControlProtocol';

export interface RemoteSessionStore {
  get(id: string): Promise<RemoteSession | null>;
  create(session: RemoteSession): Promise<{ created: boolean; session: RemoteSession }>;
  save(previous: RemoteSession, next: RemoteSession, now: number): Promise<RemoteSession>;
}

export class RemoteControlService {
  private readonly observers = new Set<(session: RemoteSession) => void>();
  subscribe(observer: (session: RemoteSession) => void) { this.observers.add(observer); return () => { this.observers.delete(observer); }; }
  /** Runtime may commit a deadline CAS directly; notify only after that commit succeeds. */
  publishCommitted(session: RemoteSession) {
    for (const observer of this.observers) { try { observer(session); } catch { /* Delivery cannot roll back a committed transition. */ } }
    return session;
  }
  private admissionStopped = false;
  private recovering = false;
  pauseAdmissionForRecovery() { this.recovering = true; }
  finishRecovery() { this.recovering = false; }
  stopAdmission() { this.admissionStopped = true; }
  constructor(private readonly store: RemoteSessionStore, private readonly now = Date.now, private readonly history?: RemoteHistoryWriter) {}
  async request(input: { requestId: string; grantId: string; grantCreatedBySid?: string; controller: RemoteEndpoint; host: RemoteEndpoint; scope: RemoteScope }) {
    if (this.admissionStopped) throw new RemoteControlError('REMOTE_SHUTTING_DOWN', 503);
    if (this.recovering) throw new RemoteControlError('RUNTIME_RECOVERING', 503);
    if (!this.history) throw new RemoteControlError('HISTORY_UNAVAILABLE', 503);
    if (input.controller.endpointId === input.host.endpointId) throw new RemoteControlError('SELF_CONTROL_NOT_ALLOWED');
    const now = this.now();
    const session: RemoteSession = {
      id: randomUUID(), requestId: input.requestId, grantId: input.grantId, grantCreatedBySid: input.grantCreatedBySid,
      requestHash: remoteDigest(input), controller: input.controller, host: input.host,
      requestedScope: input.scope, scope: 'view', state: 'pending',
      revision: 0, authorizationRevision: 0, controlEpoch: 0, controllerReady: false, hostReady: false,
      createdAt: now, deadline: now + REMOTE_LIMITS.requestMs, hardDeadline: now + REMOTE_LIMITS.sessionMs,
    };
    // Commit the request identity before any endpoint can be occupied.
    const prepared = await this.history.prepareRequest(session);
    if (this.recovering) throw new RemoteControlError('RUNTIME_RECOVERING', 503);
    if (this.admissionStopped) throw new RemoteControlError('REMOTE_SHUTTING_DOWN', 503);
    if (!prepared.created) {
      const prior = await this.store.get(prepared.sessionId);
      if (prior) return { created: false, session: prior };
      throw new RemoteControlError(['ended', 'interrupted'].includes(prepared.state) ? 'SESSION_ENDED' : 'REQUEST_IN_PROGRESS');
    }
    let created: { created: boolean; session: RemoteSession };
    try { created = await this.store.create(session); }
    catch (error) {
      // These Lua responses prove no live session was admitted. Preserve the known failure;
      // transport failures remain uncertain and are reconciled without inventing an end time.
      if (error instanceof RemoteControlError && ['ENDPOINT_BUSY', 'SESSION_EXPIRED'].includes(error.code)) {
        await this.history.archiveEnd(endRemoteSession(session, error.code, this.now()));
      }
      throw error;
    }
    try {
      if (this.recovering) throw new RemoteControlError('RUNTIME_RECOVERING', 503);
      if (this.admissionStopped) throw new RemoteControlError('REMOTE_SHUTTING_DOWN', 503);
      await this.history.assertAuthorized(created.session, true);
      if (this.recovering) throw new RemoteControlError('RUNTIME_RECOVERING', 503);
      if (this.admissionStopped) throw new RemoteControlError('REMOTE_SHUTTING_DOWN', 503);
    }
    catch (error) { await this.end(created.session.id, 'AUTH_REVOKED'); throw error; }
    this.publishCommitted(created.session);
    return created;
  }
  async act(id: string, actor: RemoteEndpoint, expectedRevision: number, action: RemoteAction) {
    const session = await this.store.get(id);
    if (!session) throw new RemoteControlError('SESSION_NOT_FOUND', 404);
    // Do not return a session or its current revision to an unrelated endpoint.
    if (!isEndpoint(session.host, actor) && !isEndpoint(session.controller, actor)) throw new RemoteControlError('NOT_A_PARTICIPANT', 403);
    if (session.state === 'ended' && ['end', 'cancel'].includes(action.type)) return session;
    if (this.history && !['end', 'cancel'].includes(action.type)) {
      try { await this.history.assertAuthorized(session); }
      catch (error) { await this.end(id, 'AUTH_REVOKED'); throw error; }
    }
    if (session.revision !== expectedRevision) throw new RemoteControlError('REVISION_CONFLICT');
    const next = transitionRemoteSession(session, actor, action, this.now());
    if (next === session) return session;
    try { return this.publishCommitted(await this.store.save(session, next, this.now())); }
    catch (error) {
      // Redis checks its commit-time clock as well: an in-flight accept/ready
      // cannot extend a deadline that elapsed while waiting for the store.
      if (!(error instanceof RemoteControlError) || error.code !== 'SESSION_EXPIRED') throw error;
      const ended = await this.end(id, 'EXPIRED');
      if (!ended) throw new RemoteControlError('SESSION_NOT_FOUND', 404);
      return ended;
    }
  }
  async end(id: string, reason: string) {
    // Lifecycle/revocation callers are trusted server code; they do not accept arbitrary socket payloads.
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = await this.store.get(id);
      if (!current || current.state === 'ended') return current;
      try { return this.publishCommitted(await this.store.save(current, endRemoteSession(current, reason, this.now()), this.now())); }
      catch (error) { if (!(error instanceof RemoteControlError) || error.code !== 'REVISION_CONFLICT') throw error; }
    }
    throw new RemoteControlError('REVISION_CONFLICT');
  }
}

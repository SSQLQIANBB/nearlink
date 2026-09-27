import { createHash, createPublicKey, randomUUID } from 'crypto';
import { RemoteControlService, type RemoteSessionStore } from './remoteControlService';
import type { RemoteHistoryWriter } from './remoteSessionHistory';
import { RemoteCredentialSigner, verifyHostConsent, verifyRemoteApproval, verifyRemoteCredential,
  type SignedRemoteEnvelope, type RemoteTransportBinding, type VerifiedHostConsent } from './remoteCredentials';
import { isEndpoint, REMOTE_LIMITS, RemoteControlError, uuid, type RemoteEndpoint, type RemoteSession } from './remoteControlProtocol';

export interface RemoteAuthorityDevice {
  id: string; ownerUserId: number; publicKey: string; keyVersion: number; fingerprint: string; revokedAt: Date | null;
}
export interface RemoteReadyEvidence extends RemoteTransportBinding {
  sessionId: string; endpoint: RemoteEndpoint; consentNonce: string; screenId: string;
  authorizationRevision: number; controlEpoch: number;
}
export interface RemoteNativeChallenge extends Omit<RemoteReadyEvidence, 'endpoint'> {
  host: RemoteEndpoint; challenge: string; leaseSeq: number; issuedAt: number; expiresAt: number;
}

/** Trusted adapter boundary, never a Socket payload interface.
 * Handles must belong to the adapter's private registry. Resolve connections from authenticated
 * presence, negotiation from authenticated SDP, ready from verified hello + observed DTLS, and
 * challenges from the native supervisor. Implementations must atomically consume one-use handles.
 * The production adapter verifies native signatures; release admission remains independently gated.
 */
export interface RemoteCoordinatorAuthority {
  resolveConnection(handle: object): Promise<RemoteEndpoint>;
  assertCurrent(endpoint: RemoteEndpoint): Promise<void>;
  assertReleased(session: RemoteSession): Promise<void>;
  device(session: RemoteSession): Promise<RemoteAuthorityDevice>;
  negotiation(session: RemoteSession): Promise<RemoteTransportBinding>;
  consumeReady(handle: object): Promise<RemoteReadyEvidence>;
  consumeNativeChallenge(handle: object): Promise<RemoteNativeChallenge>;
}
interface Context {
  deadline: number; device: RemoteAuthorityDevice;
  approval?: { id: string; proof: SignedRemoteEnvelope; revision: number };
  consent?: VerifiedHostConsent;
  binding?: RemoteTransportBinding;
  connection?: SignedRemoteEnvelope;
  connectionExpiresAt?: number;
  leaseSeq: number;
  leaseExpiresAt?: number;
}
const sameBinding = (a: RemoteTransportBinding, b: RemoteTransportBinding) => a.negotiationId === b.negotiationId
  && a.hostFingerprint === b.hostFingerprint && a.controllerFingerprint === b.controllerFingerprint;
const fail = (code: string): never => { throw new RemoteControlError(code, 403); };

/** Single-process bounded authority cache. Restart discards it; SQL history cannot reconstruct it. */
export class RemoteAuthorizationCoordinator {
  private readonly contexts = new Map<string, Context>();
  private readonly busy = new Set<string>();
  private sweepCursor?: MapIterator<[string, Context]>;
  private reclaimCursor?: MapIterator<[string, Context]>;
  private readonly capacity: number;
  constructor(private readonly service: RemoteControlService, private readonly store: Pick<RemoteSessionStore, 'get'>,
    private readonly history: Pick<RemoteHistoryWriter, 'assertAuthorized'>, private readonly signer: RemoteCredentialSigner,
    private readonly authority: RemoteCoordinatorAuthority, private readonly now = Date.now, capacity = 128) {
    this.capacity = Math.max(1, Math.min(4096, Math.floor(capacity) || 128));
  }
  /** Called by the owner on lifecycle cleanup; an independent timer is deliberately not installed. */
  sweep(limit = 25) {
    const count = Math.max(1, Math.min(100, Math.floor(limit) || 25));
    this.sweepCursor ||= this.contexts.entries();
    for (let i = 0; i < count; i++) {
      const next = this.sweepCursor.next();
      if (next.done) { this.sweepCursor = undefined; break; }
      const [id, context] = next.value;
      if (!this.busy.has(id) && context.deadline <= this.now()) this.contexts.delete(id);
    }
  }
  /** Trusted lifecycle hook only. Recheck busy after the store read to protect in-flight operations. */
  async forgetEnded(id: string): Promise<boolean> {
    uuid.parse(id);
    if (this.busy.has(id) || !this.contexts.has(id)) return false;
    const session = await this.store.get(id);
    if (this.busy.has(id) || (session && session.state !== 'ended')) return false;
    return this.contexts.delete(id);
  }
  private async reclaimEnded() {
    this.reclaimCursor ||= this.contexts.entries();
    for (let scanned = 0; scanned < 25; scanned++) {
      const next = this.reclaimCursor.next();
      if (next.done) { this.reclaimCursor = undefined; break; }
      await this.forgetEnded(next.value[0]);
    }
  }
  private async run<T>(id: string, action: () => Promise<T>): Promise<T> {
    uuid.parse(id); this.sweep();
    if (this.busy.has(id)) throw new RemoteControlError('REMOTE_OPERATION_IN_PROGRESS');
    if (this.busy.size >= this.capacity) throw new RemoteControlError('REMOTE_COORDINATOR_CAPACITY', 503);
    this.busy.add(id);
    try { return await action(); } finally { this.busy.delete(id); }
  }
  private context(id: string): Context {
    const context = this.contexts.get(id);
    if (!context || context.deadline <= this.now()) return fail('REMOTE_AUTHORITY_MISSING');
    return context;
  }
  private assertDeadlines(session: RemoteSession, context: Context | undefined, now: number) {
    if (Math.min(session.deadline, session.hardDeadline) <= now) return fail('SESSION_EXPIRED');
    if (session.state === 'active' && context?.connection
      && (context.leaseExpiresAt ?? context.connectionExpiresAt!) <= now) return fail('LEASE_EXPIRED');
  }
  private async fresh(id: string, connection: object, context?: Context) {
    const actor = Object.freeze({ ...await this.authority.resolveConnection(connection) });
    const session = await this.store.get(id);
    if (!session) throw new RemoteControlError('SESSION_NOT_FOUND', 404);
    if (!isEndpoint(session.host, actor) && !isEndpoint(session.controller, actor)) return fail('NOT_A_PARTICIPANT');
    if (session.state === 'ended') { this.contexts.delete(id); return fail('SESSION_ENDED'); }
    if (Math.min(session.deadline, session.hardDeadline) <= this.now()) { await this.service.end(id, 'EXPIRED'); return fail('SESSION_EXPIRED'); }
    try {
      await this.history.assertAuthorized(session);
      await this.authority.assertReleased(session);
      await this.authority.assertCurrent(session.host);
      await this.authority.assertCurrent(session.controller);
      const device = await this.authority.device(session);
      const fingerprint = createHash('sha256').update(createPublicKey(device.publicKey).export({ type: 'spki', format: 'der' })).digest('hex');
      if (device.revokedAt || device.id !== session.host.endpointId || device.ownerUserId !== session.host.userId
        || device.fingerprint !== fingerprint || !Number.isSafeInteger(device.keyVersion) || device.keyVersion < 1
        || (context && (device.keyVersion !== context.device.keyVersion || device.fingerprint !== context.device.fingerprint))) return fail('DEVICE_AUTHORITY_CHANGED');
      if (context?.binding && !sameBinding(context.binding, await this.authority.negotiation(session))) return fail('TRANSPORT_BINDING_CHANGED');
      this.assertDeadlines(session, context, this.now());
      // The runtime may end/pause the session while SQL/presence checks are in flight.
      const current = await this.store.get(id);
      if (!current || current.revision !== session.revision || current.state !== session.state) return fail('REVISION_CONFLICT');
      this.assertDeadlines(current, context, this.now());
      return { session: current, actor, device };
    } catch (error) {
      await this.service.end(id, 'AUTHORITY_INVALID');
      this.contexts.delete(id);
      throw error;
    }
  }
  async prepareApproval(id: string, connection: object) {
    return this.run(id, async () => {
      let context = this.contexts.get(id);
      let { session, device } = await this.fresh(id, connection, context);
      if (!(session.state === 'pending' || (session.state === 'active' && session.scope === 'view'))) return fail('INVALID_TRANSITION');
      if (!context) {
        if (this.contexts.size >= this.capacity) {
          await this.reclaimEnded();
          // Collection waited for Redis. Revalidate the target before signing its prompt.
          ({ session, device } = await this.fresh(id, connection));
        }
        if (this.contexts.size >= this.capacity) throw new RemoteControlError('REMOTE_COORDINATOR_CAPACITY', 503);
        context = { deadline: session.hardDeadline, device: { ...device }, leaseSeq: 0 };
        this.contexts.set(id, context);
      }
      if (context.approval?.revision === session.revision) return context.approval.proof;
      const approvalId = randomUUID();
      const proof = Object.freeze(this.signer.issueApprovalRequest(session, device, approvalId, this.now()));
      context.approval = { id: approvalId, proof, revision: session.revision };
      return proof;
    });
  }
  async consent(id: string, connection: object, envelope: unknown) {
    return this.run(id, async () => {
      const context = this.context(id);
      const { session, actor, device } = await this.fresh(id, connection, context);
      if (!isEndpoint(session.host, actor)) return fail('HOST_REQUIRED');
      if (!context.approval || context.approval.revision !== session.revision) return fail('APPROVAL_REQUIRED');
      const approval = verifyRemoteApproval(context.approval.proof, this.signer.publicKey, this.now());
      const consent = verifyHostConsent(envelope, session, device, this.now());
      const claims = consent.claims;
      if (claims.approvalId !== context.approval.id || claims.screenId !== 'primary'
        || claims.issuedAt < approval.issuedAt || claims.expiresAt > approval.expiresAt
        || (context.consent && claims.consentNonce === context.consent.claims.consentNonce)) return fail('APPROVAL_MISMATCH');
      if (claims.action === 'grant-control' && claims.decision !== 'control') {
        context.approval = undefined;
        return (await this.fresh(id, connection, context)).session;
      }
      const next = await this.service.act(id, actor, session.revision, claims.action === 'accept'
        ? { type: 'respond', accepted: claims.decision !== 'reject', scope: claims.decision === 'control' ? 'control' : 'view' }
        : { type: 'grant-control' });
      context.approval = undefined;
      if (next.state === 'ended') { this.contexts.delete(id); return next; }
      context.consent = consent;
      return (await this.fresh(id, connection, context)).session;
    });
  }
  async bindTransport(id: string, connection: object) {
    return this.run(id, async () => {
      const context = this.context(id);
      const { session } = await this.fresh(id, connection, context);
      if (session.state !== 'connecting' || !context.consent) return fail('CONNECTION_NOT_AUTHORIZED');
      if (context.connection) {
        if (context.connectionExpiresAt! <= this.now()) return fail('CONNECTION_EXPIRED');
        return context.connection;
      }
      const binding = { ...await this.authority.negotiation(session) };
      context.binding = Object.freeze(binding);
      const fresh = await this.fresh(id, connection, context);
      const proof = Object.freeze(this.signer.issueConnection(fresh.session, context.consent, binding, this.now()));
      context.connectionExpiresAt = verifyRemoteCredential(proof, this.signer.publicKey, this.now()).expiresAt;
      context.connection = proof;
      return proof;
    });
  }
  private matchesEvidence(evidence: RemoteReadyEvidence | RemoteNativeChallenge, session: RemoteSession, context: Context) {
    // A one-way pause cannot require the host to know the new revision before it receives
    // the signed view lease. The old locally confirmed binding may request only that downgrade.
    const revisionMatches = evidence.authorizationRevision === session.authorizationRevision && evidence.controlEpoch === session.controlEpoch;
    const downgrade = 'leaseSeq' in evidence && session.scope === 'view' && context.consent
      && evidence.authorizationRevision === context.consent.claims.authorizationRevision
      && evidence.controlEpoch === context.consent.claims.controlEpoch
      && evidence.authorizationRevision < session.authorizationRevision && evidence.controlEpoch < session.controlEpoch;
    return !!context.binding && !!context.consent && evidence.sessionId === session.id && sameBinding(evidence, context.binding)
      && evidence.consentNonce === context.consent.claims.consentNonce && evidence.screenId === context.consent.claims.screenId
      && (revisionMatches || !!downgrade);
  }
  async ready(id: string, connection: object, receipt: object) {
    return this.run(id, async () => {
      const context = this.context(id);
      const { session, actor } = await this.fresh(id, connection, context);
      if (session.state !== 'connecting' || !context.connection || context.connectionExpiresAt! <= this.now()) return fail('CONNECTION_NOT_AUTHORIZED');
      const evidence = await this.authority.consumeReady(receipt);
      if (!isEndpoint(actor, evidence.endpoint) || !this.matchesEvidence(evidence, session, context)) return fail('READY_BINDING_MISMATCH');
      await this.service.act(id, actor, session.revision, { type: 'ready' });
      return (await this.fresh(id, connection, context)).session;
    });
  }
  async lease(id: string, connection: object, challengeHandle: object) {
    return this.run(id, async () => {
      const context = this.context(id);
      let { session, actor } = await this.fresh(id, connection, context);
      if (!isEndpoint(actor, session.host)) return fail('HOST_REQUIRED');
      if (session.state !== 'active' || !session.hostReady || !session.controllerReady || !context.connection || !context.consent) return fail('LEASE_NOT_AUTHORIZED');
      const challenge = await this.authority.consumeNativeChallenge(challengeHandle);
      const now = this.now();
      if (!isEndpoint(session.host, challenge.host) || !this.matchesEvidence(challenge, session, context)
        || !Number.isSafeInteger(challenge.leaseSeq) || challenge.leaseSeq <= context.leaseSeq
        || !Number.isSafeInteger(challenge.issuedAt) || !Number.isSafeInteger(challenge.expiresAt)
        || challenge.issuedAt > now || challenge.expiresAt <= now || challenge.expiresAt - challenge.issuedAt > REMOTE_LIMITS.challengeMs) return fail('NATIVE_CHALLENGE_MISMATCH');
      ({ session } = await this.fresh(id, connection, context));
      const issuedAt = this.now();
      this.assertDeadlines(session, context, issuedAt);
      if (!this.matchesEvidence(challenge, session, context) || challenge.expiresAt <= issuedAt) return fail('NATIVE_CHALLENGE_MISMATCH');
      const proof = Object.freeze(this.signer.issueLease(session, context.consent, context.binding!, challenge.challenge, challenge.leaseSeq, issuedAt));
      context.leaseSeq = challenge.leaseSeq;
      context.leaseExpiresAt = verifyRemoteCredential(proof, this.signer.publicKey, this.now()).expiresAt;
      return proof;
    });
  }
  async pause(id: string, connection: object) {
    return this.run(id, async () => {
      const context = this.context(id);
      const { session, actor } = await this.fresh(id, connection, context);
      const next = await this.service.act(id, actor, session.revision, { type: 'pause' });
      context.approval = undefined;
      return next;
    });
  }
  async end(id: string, connection: object) {
    return this.run(id, async () => {
      const actor = await this.authority.resolveConnection(connection);
      const session = await this.store.get(id);
      if (!session || (!isEndpoint(actor, session.host) && !isEndpoint(actor, session.controller))) return fail('NOT_A_PARTICIPANT');
      try { return await this.service.act(id, actor, session.revision, { type: 'end' }); }
      finally { this.contexts.delete(id); }
    });
  }
}

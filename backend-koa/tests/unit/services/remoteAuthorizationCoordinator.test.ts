import { describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'crypto';
import { RemoteAuthorizationCoordinator, type RemoteAuthorityDevice, type RemoteCoordinatorAuthority,
  type RemoteNativeChallenge, type RemoteReadyEvidence } from '../../../src/services/remoteAuthorizationCoordinator';
import { RemoteControlService, type RemoteSessionStore } from '../../../src/services/remoteControlService';
import { RemoteControlError, isEndpoint, type RemoteEndpoint, type RemoteSession } from '../../../src/services/remoteControlProtocol';
import { RemoteCredentialSigner, remoteSignatureMessage, verifyRemoteApproval, verifyRemoteCredential,
  type HostConsentClaims, type RemoteTransportBinding } from '../../../src/services/remoteCredentials';
import type { RemoteHistoryWriter } from '../../../src/services/remoteSessionHistory';

class MemoryStore implements RemoteSessionStore {
  records = new Map<string, RemoteSession>();
  async get(id: string) { return structuredClone(this.records.get(id) || null); }
  async create(session: RemoteSession) { this.records.set(session.id, structuredClone(session)); return { created: true, session: structuredClone(session) }; }
  async save(previous: RemoteSession, next: RemoteSession) {
    if (this.records.get(previous.id)?.revision !== previous.revision) throw new RemoteControlError('REVISION_CONFLICT');
    this.records.set(previous.id, structuredClone(next)); return structuredClone(next);
  }
}
/** A typed adapter with private one-use registries; ordinary JSON objects never have authority. */
class TestAuthority implements RemoteCoordinatorAuthority {
  private connections = new WeakMap<object, RemoteEndpoint>();
  private ready = new WeakMap<object, RemoteReadyEvidence>();
  private challenges = new WeakMap<object, RemoteNativeChallenge>();
  current = new Map<string, RemoteEndpoint>();
  released = true;
  binding: RemoteTransportBinding = { negotiationId: randomUUID(), hostFingerprint: 'AB'.repeat(32), controllerFingerprint: 'CD'.repeat(32) };
  constructor(public hostDevice: RemoteAuthorityDevice) {}
  connect(endpoint: RemoteEndpoint) { const handle = {}; this.connections.set(handle, structuredClone(endpoint)); this.current.set(endpoint.endpointId, structuredClone(endpoint)); return handle; }
  observedReady(evidence: RemoteReadyEvidence) { const handle = {}; this.ready.set(handle, structuredClone(evidence)); return handle; }
  nativeChallenge(challenge: RemoteNativeChallenge) { const handle = {}; this.challenges.set(handle, structuredClone(challenge)); return handle; }
  async resolveConnection(handle: object) { const endpoint = this.connections.get(handle); if (!endpoint) throw new Error('UNKNOWN_CONNECTION'); return structuredClone(endpoint); }
  async assertCurrent(endpoint: RemoteEndpoint) {
    const current = this.current.get(endpoint.endpointId);
    if (!current || !isEndpoint(endpoint, current)) throw new Error('CONNECTION_REPLACED');
  }
  async assertReleased() { if (!this.released) throw new Error('RELEASE_CLOSED'); }
  async device() { return { ...this.hostDevice }; }
  async negotiation() { return { ...this.binding }; }
  async consumeReady(handle: object) { const receipt = this.ready.get(handle); this.ready.delete(handle); if (!receipt) throw new Error('UNKNOWN_READY'); return receipt; }
  async consumeNativeChallenge(handle: object) { const receipt = this.challenges.get(handle); this.challenges.delete(handle); if (!receipt) throw new Error('UNKNOWN_NATIVE_CHALLENGE'); return receipt; }
}
async function fixture(capacity = 128, scope: 'view' | 'control' = 'control') {
  let now = 1_700_000_000_000;
  const endpoint = (userId: number): RemoteEndpoint => ({ userId, sid: randomUUID(), authVersion: randomUUID(), endpointId: randomUUID(), connectionId: randomUUID(), generation: 1 });
  const host = endpoint(1), controller = endpoint(2), creatorSid = randomUUID(), grantId = randomUUID();
  const hostKeys = generateKeyPairSync('ed25519');
  const hostDevice: RemoteAuthorityDevice = { id: host.endpointId, ownerUserId: host.userId, keyVersion: 1, revokedAt: null,
    publicKey: hostKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    fingerprint: createHash('sha256').update(hostKeys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex') };
  const authority = new TestAuthority(hostDevice);
  const hostConnection = authority.connect(host), controllerConnection = authority.connect(controller);
  const accounts = new Map([[host.userId, host.authVersion], [controller.userId, controller.authVersion]]);
  const sids = new Set([host.sid, controller.sid, creatorSid]);
  let grantActive = true;
  const history: RemoteHistoryWriter = {
    async prepareRequest(session) { await this.assertAuthorized(session); return { created: true, sessionId: session.id, state: 'pending' }; },
    async assertAuthorized(session) {
      if ([session.host, session.controller].some(e => accounts.get(e.userId) !== e.authVersion || !sids.has(e.sid))
        || !sids.has(session.grantCreatedBySid!) || !grantActive || session.grantId !== grantId) throw new RemoteControlError('AUTH_REVOKED');
    },
    async archiveEnd() {},
  };
  const store = new MemoryStore();
  const service = new RemoteControlService(store, () => now, history);
  const signing = generateKeyPairSync('ed25519');
  const signer = new RemoteCredentialSigner('test-server', signing.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), now - 1, now + 3_600_000);
  const coordinator = new RemoteAuthorizationCoordinator(service, store, history, signer, authority, () => now, capacity);
  const session = (await service.request({ requestId: randomUUID(), grantId, grantCreatedBySid: creatorSid, host, controller, scope })).session;
  function signedConsent(claims: HostConsentClaims, keyVersion = 1) {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url'), keyId = `device:${host.endpointId}:${keyVersion}`;
    return { format: 'rc-signed-v1', keyId, payload, signature: sign(null, remoteSignatureMessage(keyId, payload), hostKeys.privateKey).toString('base64url') };
  }
  async function approval(decision: 'view' | 'control' | 'reject' = scope, edits: Partial<HostConsentClaims> = {}) {
    const envelope = await coordinator.prepareApproval(session.id, controllerConnection);
    const request = verifyRemoteApproval(envelope, signer.publicKey, now);
    const claims: HostConsentClaims = { protocolVersion: 1, purpose: 'host-consent', approvalId: request.approvalId,
      action: request.action, authorizationRevision: request.authorizationRevision, controlEpoch: request.controlEpoch,
      sessionId: session.id, host, controller, requestedScope: request.requestedScope, decision,
      consentNonce: randomBytes(32).toString('base64url'), screenId: 'primary', issuedAt: now, expiresAt: request.expiresAt, ...edits };
    return { envelope, claims, consent: signedConsent(claims) };
  }
  let lastConsent: HostConsentClaims;
  async function accept(decision: 'view' | 'control' = scope) {
    const a = await approval(decision); lastConsent = a.claims;
    await coordinator.consent(session.id, hostConnection, a.consent);
    const connection = await coordinator.bindTransport(session.id, controllerConnection);
    return { ...a, connection };
  }
  async function evidence(who = host): Promise<RemoteReadyEvidence> {
    const current = (await store.get(session.id))!;
    return { sessionId: session.id, endpoint: who, ...authority.binding, consentNonce: lastConsent.consentNonce,
      screenId: 'primary', authorizationRevision: current.authorizationRevision, controlEpoch: current.controlEpoch };
  }
  async function ready(who = host) {
    return coordinator.ready(session.id, who === host ? hostConnection : controllerConnection, authority.observedReady(await evidence(who)));
  }
  async function active() { const a = await accept(); await ready(host); await ready(controller); return a; }
  async function challenge(seq = 1, edits: Partial<RemoteNativeChallenge> = {}) {
    const { endpoint: _, ...binding } = await evidence();
    return authority.nativeChallenge({ ...binding, host, challenge: randomBytes(32).toString('base64url'),
      leaseSeq: seq, issuedAt: now, expiresAt: now + 30_000, ...edits });
  }
  return { coordinator, authority, signer, store, service, history, session, host, controller, accounts, sids, creatorSid,
    hostConnection, controllerConnection, approval, signedConsent, accept, active, ready, evidence, challenge,
    setConsent: (claims: HostConsentClaims) => { lastConsent = claims; }, revokeGrant: () => { grantActive = false; },
    now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('remote authority coordinator (real Ed25519, trusted adapter handles)', () => {
  it('completes durable pending → signed approval → consent → connection → both ready → native lease', async () => {
    const f = await fixture();
    const a = await f.accept();
    expect(verifyRemoteApproval(a.envelope, f.signer.publicKey, f.now()).approvalId).toBe(a.claims.approvalId);
    expect(verifyRemoteCredential(a.connection, f.signer.publicKey, f.now())).toMatchObject({ purpose: 'connection', scope: 'control' });
    expect((await f.ready()).state).toBe('connecting');
    expect((await f.ready(f.controller)).state).toBe('active');
    const lease = await f.coordinator.lease(f.session.id, f.hostConnection, await f.challenge());
    expect(verifyRemoteCredential(lease, f.signer.publicKey, f.now())).toMatchObject({ purpose: 'lease', scope: 'control', leaseSeq: 1 });
    expect((await f.coordinator.end(f.session.id, f.controllerConnection))!.state).toBe('ended');
  });
  it('allows an old locally confirmed challenge only to receive the signed pause downgrade, never to restore control', async () => {
    const f = await fixture(); await f.active();
    const original = await f.evidence();
    await f.coordinator.pause(f.session.id, f.controllerConnection);
    const lease = await f.coordinator.lease(f.session.id, f.hostConnection, await f.challenge(1, {
      authorizationRevision: original.authorizationRevision, controlEpoch: original.controlEpoch,
    }));
    expect(verifyRemoteCredential(lease, f.signer.publicKey, f.now())).toMatchObject({ scope: 'view', authorizationRevision: 2, controlEpoch: 2 });
    const approval = await f.approval('control');
    await f.coordinator.consent(f.session.id, f.hostConnection, approval.consent); f.setConsent(approval.claims);
    await expect(f.coordinator.lease(f.session.id, f.hostConnection, await f.challenge(2, {
      authorizationRevision: original.authorizationRevision, controlEpoch: original.controlEpoch,
    }))).rejects.toThrow('NATIVE_CHALLENGE_MISMATCH');
  });
  it('uses one pending approval per revision and rejects booleans, altered screen, wrong prompt, and duplicate consent', async () => {
    const f = await fixture(); const a = await f.approval();
    expect(await f.coordinator.prepareApproval(f.session.id, f.hostConnection)).toEqual(a.envelope);
    for (const proof of [{ accepted: true }, f.signedConsent({ ...a.claims, screenId: 'another-screen' }),
      f.signedConsent({ ...a.claims, approvalId: randomUUID() }), { ...a.consent, signature: 'A'.repeat(86) }]) {
      await expect(f.coordinator.consent(f.session.id, f.hostConnection, proof)).rejects.toThrow();
    }
    expect((await f.store.get(f.session.id))!.state).toBe('pending');
    await f.coordinator.consent(f.session.id, f.hostConnection, a.consent);
    await expect(f.coordinator.consent(f.session.id, f.hostConnection, a.consent)).rejects.toThrow('APPROVAL_REQUIRED');
  });
  it('rejects late approvals, wrong signing key versions, and view-to-control consent escalation', async () => {
    const f = await fixture(128, 'view'); const a = await f.approval();
    await expect(f.coordinator.consent(f.session.id, f.hostConnection, f.signedConsent(a.claims, 2))).rejects.toThrow();
    await expect(f.coordinator.consent(f.session.id, f.hostConnection, f.signedConsent({ ...a.claims, decision: 'control' }))).rejects.toThrow();
    f.advance(45_000);
    await expect(f.coordinator.consent(f.session.id, f.hostConnection, a.consent)).rejects.toThrow('SESSION_EXPIRED');
    expect((await f.store.get(f.session.id))!.state).toBe('ended');
  });
  it('rejects Web ready/challenge objects and leases before both endpoints are ready', async () => {
    const f = await fixture(); await f.accept();
    await expect(f.coordinator.ready(f.session.id, f.hostConnection, { ready: true })).rejects.toThrow('UNKNOWN_READY');
    await f.ready();
    await expect(f.coordinator.lease(f.session.id, f.hostConnection, await f.challenge())).rejects.toThrow('LEASE_NOT_AUTHORIZED');
    await f.ready(f.controller);
    await expect(f.coordinator.lease(f.session.id, f.hostConnection, { native: true, challenge: randomBytes(32).toString('base64url') })).rejects.toThrow('UNKNOWN_NATIVE_CHALLENGE');
    await expect(f.coordinator.lease(f.session.id, f.controllerConnection, await f.challenge())).rejects.toThrow('HOST_REQUIRED');
  });
  it('requires observed DTLS evidence to match pinned transport and the authenticated ready sender', async () => {
    const f = await fixture(); await f.accept();
    for (const edit of [{ hostFingerprint: 'EF'.repeat(32) }, { negotiationId: randomUUID() }, { endpoint: f.controller }, { consentNonce: randomBytes(32).toString('base64url') }]) {
      const handle = f.authority.observedReady({ ...await f.evidence(), ...edit });
      await expect(f.coordinator.ready(f.session.id, f.hostConnection, handle)).rejects.toThrow('READY_BINDING_MISMATCH');
    }
    expect((await f.store.get(f.session.id))!.hostReady).toBe(false);
    f.authority.binding = { ...f.authority.binding, controllerFingerprint: 'EF'.repeat(32) };
    await expect(f.coordinator.ready(f.session.id, f.hostConnection, f.authority.observedReady(await f.evidence()))).rejects.toThrow('TRANSPORT_BINDING_CHANGED');
    expect((await f.store.get(f.session.id))!.state).toBe('ended');
  });
  it.each(['account', 'sid', 'creator', 'grant', 'device', 'key', 'connection', 'release'] as const)('revalidates %s before lease issuance', async kind => {
    const f = await fixture(); await f.active();
    const challenge = await f.challenge();
    if (kind === 'account') f.accounts.set(f.host.userId, randomUUID());
    if (kind === 'sid') f.sids.delete(f.controller.sid);
    if (kind === 'creator') f.sids.delete(f.creatorSid);
    if (kind === 'grant') f.revokeGrant();
    if (kind === 'device') f.authority.hostDevice.revokedAt = new Date();
    if (kind === 'key') f.authority.hostDevice.keyVersion++;
    if (kind === 'connection') f.authority.current.set(f.host.endpointId, { ...f.host, generation: 2 });
    if (kind === 'release') f.authority.released = false;
    await expect(f.coordinator.lease(f.session.id, f.hostConnection, challenge)).rejects.toThrow();
    expect((await f.store.get(f.session.id))!.state).toBe('ended');
  });
  it('native challenge handles are single use and bind sequence, nonce, screen, revision and both fingerprints', async () => {
    const f = await fixture(); await f.active();
    const first = await f.challenge();
    await f.coordinator.lease(f.session.id, f.hostConnection, first);
    await expect(f.coordinator.lease(f.session.id, f.hostConnection, first)).rejects.toThrow('UNKNOWN_NATIVE_CHALLENGE');
    for (const edit of [{ leaseSeq: 1 }, { consentNonce: randomBytes(32).toString('base64url') }, { screenId: 'secondary' },
      { authorizationRevision: 0 }, { controlEpoch: 0 }, { hostFingerprint: 'EF'.repeat(32) }, { host: { ...f.host, generation: 2 } }, { expiresAt: f.now() }]) {
      await expect(f.coordinator.lease(f.session.id, f.hostConnection, await f.challenge(2, edit))).rejects.toThrow('NATIVE_CHALLENGE_MISMATCH');
    }
    expect(verifyRemoteCredential(await f.coordinator.lease(f.session.id, f.hostConnection, await f.challenge(3)), f.signer.publicKey, f.now()).leaseSeq).toBe(3);
  });
  it('pause downgrades leases; restoring control needs a new approval, new nonce, and exact higher epochs', async () => {
    const f = await fixture(); const old = await f.active();
    await f.coordinator.lease(f.session.id, f.hostConnection, await f.challenge());
    await f.coordinator.pause(f.session.id, f.controllerConnection);
    expect(verifyRemoteCredential(await f.coordinator.lease(f.session.id, f.hostConnection, await f.challenge(2)), f.signer.publicKey, f.now()).scope).toBe('view');
    const a = await f.approval('control');
    await expect(f.coordinator.consent(f.session.id, f.hostConnection, old.consent)).rejects.toThrow();
    await expect(f.coordinator.consent(f.session.id, f.hostConnection, f.signedConsent({ ...a.claims, consentNonce: old.claims.consentNonce }))).rejects.toThrow('APPROVAL_MISMATCH');
    await f.coordinator.consent(f.session.id, f.hostConnection, a.consent); f.setConsent(a.claims);
    const lease = await f.coordinator.lease(f.session.id, f.hostConnection, await f.challenge(3));
    expect(verifyRemoteCredential(lease, f.signer.publicKey, f.now())).toMatchObject({ scope: 'control', authorizationRevision: 3, controlEpoch: 3, consentNonce: a.claims.consentNonce });
  });
  it('initial rejection ends pending; declining a control restoration keeps the active viewing session', async () => {
    const rejected = await fixture(); const no = await rejected.approval('reject');
    expect((await rejected.coordinator.consent(rejected.session.id, rejected.hostConnection, no.consent)).state).toBe('ended');
    const f = await fixture(); await f.active(); await f.coordinator.pause(f.session.id, f.hostConnection);
    const before = await f.store.get(f.session.id), a = await f.approval('reject');
    expect(await f.coordinator.consent(f.session.id, f.hostConnection, a.consent)).toEqual(before);
    const next = await f.approval('control');
    expect(next.claims.approvalId).not.toBe(a.claims.approvalId);
    await expect(f.coordinator.consent(f.session.id, f.hostConnection, a.consent)).rejects.toThrow('APPROVAL_MISMATCH');
  });
  it('an expired lease cannot be revived by a fresh native challenge', async () => {
    const f = await fixture(); await f.active();
    await f.coordinator.lease(f.session.id, f.hostConnection, await f.challenge());
    f.advance(15_000);
    await expect(f.coordinator.lease(f.session.id, f.hostConnection, await f.challenge(2))).rejects.toThrow('LEASE_EXPIRED');
    expect((await f.store.get(f.session.id))!.state).toBe('ended');
  });
  it('state changes during awaited native challenge verification cannot produce a stale lease', async () => {
    const f = await fixture(); await f.active();
    const consume = f.authority.consumeNativeChallenge.bind(f.authority);
    f.authority.consumeNativeChallenge = async handle => { const value = await consume(handle); await f.service.end(f.session.id, 'REVOKED'); return value; };
    await expect(f.coordinator.lease(f.session.id, f.hostConnection, await f.challenge())).rejects.toThrow('SESSION_ENDED');
  });
  it('a final state read that crosses the preceding lease deadline cannot revive authorization', async () => {
    const f = await fixture(); await f.active();
    await f.coordinator.lease(f.session.id, f.hostConnection, await f.challenge());
    const next = await f.challenge(2), get = f.store.get.bind(f.store);
    let reads = 0;
    f.store.get = async id => {
      const value = await get(id);
      // First fresh(): initial and final reads. Delay the latter beyond the live lease.
      if (++reads === 2) f.advance(15_000);
      return value;
    };
    await expect(f.coordinator.lease(f.session.id, f.hostConnection, next)).rejects.toThrow('LEASE_EXPIRED');
    expect((await get(f.session.id))!.state).toBe('ended');
  });
  it('limits contexts and concurrent operations without an unbounded queue', async () => {
    const f = await fixture(1);
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const original = f.authority.assertCurrent.bind(f.authority);
    f.authority.assertCurrent = async endpoint => { await wait; await original(endpoint); };
    const inFlight = f.coordinator.prepareApproval(f.session.id, f.controllerConnection);
    await expect(f.coordinator.prepareApproval(f.session.id, f.controllerConnection)).rejects.toThrow('REMOTE_OPERATION_IN_PROGRESS');
    release(); await inFlight; f.authority.assertCurrent = original;
    const another = { ...f.session, id: randomUUID() }; await f.store.create(another);
    await expect(f.coordinator.prepareApproval(another.id, f.controllerConnection)).rejects.toThrow('REMOTE_COORDINATOR_CAPACITY');
    await f.coordinator.end(f.session.id, f.controllerConnection);
    await expect(f.coordinator.prepareApproval(another.id, f.controllerConnection)).resolves.toHaveProperty('format', 'rc-signed-v1');
  });
  it('reclaims runtime-ended contexts at capacity and exposes a safe absent/ended lifecycle hook', async () => {
    const f = await fixture(1);
    await f.coordinator.prepareApproval(f.session.id, f.controllerConnection);
    expect(await f.coordinator.forgetEnded(f.session.id)).toBe(false);
    await f.service.end(f.session.id, 'EXPIRED'); // Existing runtime does not call coordinator.end.
    const next = { ...f.session, id: randomUUID() }; await f.store.create(next);
    await expect(f.coordinator.prepareApproval(next.id, f.controllerConnection)).resolves.toHaveProperty('format', 'rc-signed-v1');
    expect(await f.coordinator.forgetEnded(f.session.id)).toBe(false); // Already collected.
    f.store.records.delete(next.id);
    expect(await f.coordinator.forgetEnded(next.id)).toBe(true);
  });
  it('never reclaims an active authority or an operation still using a terminal context', async () => {
    const f = await fixture(1); await f.active();
    expect(await f.coordinator.forgetEnded(f.session.id)).toBe(false);
    const next = { ...f.session, id: randomUUID() }; await f.store.create(next);
    await expect(f.coordinator.prepareApproval(next.id, f.controllerConnection)).rejects.toThrow('REMOTE_COORDINATOR_CAPACITY');
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const resolve = f.authority.resolveConnection.bind(f.authority);
    f.authority.resolveConnection = async handle => { await waiting; return resolve(handle); };
    const ending = f.coordinator.end(f.session.id, f.hostConnection);
    await f.service.end(f.session.id, 'EXTERNAL_STOP');
    expect(await f.coordinator.forgetEnded(f.session.id)).toBe(false);
    release(); await ending;
  });
  it('capacity reclamation reads at most 25 context states per attempt', async () => {
    const f = await fixture(30), ids = [f.session.id];
    await f.coordinator.prepareApproval(f.session.id, f.controllerConnection);
    for (let i = 1; i < 30; i++) {
      const next = { ...f.session, id: randomUUID() }; ids.push(next.id); await f.store.create(next);
      await f.coordinator.prepareApproval(next.id, f.controllerConnection);
    }
    for (const id of ids) await f.service.end(id, 'EXPIRED');
    const next = { ...f.session, id: randomUUID() }; await f.store.create(next);
    const get = f.store.get.bind(f.store), reads: string[] = [];
    f.store.get = async id => { reads.push(id); return get(id); };
    await f.coordinator.prepareApproval(next.id, f.controllerConnection);
    expect(reads.filter(id => id !== next.id)).toHaveLength(25);
  });
  it('rechecks busy after an awaited terminal read before deleting a context', async () => {
    const f = await fixture(); await f.coordinator.prepareApproval(f.session.id, f.controllerConnection);
    await f.service.end(f.session.id, 'EXPIRED');
    let releaseRead!: () => void, releaseOperation!: () => void;
    const reading = new Promise<void>(resolve => { releaseRead = resolve; });
    const working = new Promise<void>(resolve => { releaseOperation = resolve; });
    const get = f.store.get.bind(f.store), resolve = f.authority.resolveConnection.bind(f.authority);
    f.store.get = async id => { const value = await get(id); await reading; return value; };
    f.authority.resolveConnection = async handle => { await working; return resolve(handle); };
    const collecting = f.coordinator.forgetEnded(f.session.id);
    const ending = f.coordinator.end(f.session.id, f.hostConnection);
    releaseRead();
    expect(await collecting).toBe(false);
    releaseOperation(); await ending;
  });
});

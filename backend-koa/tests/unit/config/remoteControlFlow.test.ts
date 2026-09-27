import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'crypto';
const mocks = vi.hoisted(() => ({ context: null as any, grant: vi.fn(), authenticate: vi.fn() }));
vi.mock('../../../src/services/remoteControlContext', () => ({ getRemoteControlContext: () => mocks.context }));
vi.mock('../../../src/models/RemoteControl', () => ({ AssistanceGrant: { findOne: mocks.grant } }));
vi.mock('../../../src/services/loginSessionService', () => ({ validateAuthenticatedSession: mocks.authenticate }));
vi.mock('../../../src/services/remoteControlPolicy', () => ({ getRemoteControlCapabilities: () => ({ desktopHostEnabled: true, desktopControllerEnabled: true, webControllerReleaseEnabled: true, releasedPlatforms: ['macos'], reason: 'TEST_ONLY' }) }));
import { initializeRemoteControl } from '../../../src/config/remoteControl';
import { RemoteControlService } from '../../../src/services/remoteControlService';
import { RemoteLiveAuthority } from '../../../src/services/remoteLiveAuthority';
import { RemoteAuthorizationCoordinator } from '../../../src/services/remoteAuthorizationCoordinator';
import { RemoteCredentialSigner, remoteSignatureMessage, verifyRemoteCredential } from '../../../src/services/remoteCredentials';
import { RemoteControlError, type RemoteSession } from '../../../src/services/remoteControlProtocol';

class Socket {
  id = randomUUID(); data: any = {}; conn = { readyState: 'open' }; handlers = new Map<string, Function>();
  received: Array<{ event: string; value: any }> = [];
  constructor(public handshake: { auth: any }) {}
  on(event: string, fn: Function) { this.handlers.set(event, fn); }
  emit(event: string, value: unknown) { this.received.push({ event, value }); }
  disconnect() { this.handlers.get('disconnect')?.(); }
  async send(event: string, value: unknown) { let result: any; await this.handlers.get(event)?.(value, (r: unknown) => { result = r; }); return result; }
  last(event: string) { return this.received.findLast(e => e.event === event)?.value; }
}
const sockets: Socket[] = [];
afterEach(() => { sockets.splice(0).forEach(s => s.disconnect()); });
async function fixture() {
  const now = Date.now();
  const hostAuth = { userId: 1, username: 'host', sid: randomUUID(), authVersion: randomUUID(), exp: Math.floor(now / 1000) + 3600 };
  const controllerAuth = { ...hostAuth, userId: 2, username: 'controller', sid: randomUUID(), authVersion: randomUUID() };
  mocks.authenticate.mockImplementation(async token => token === 'host' ? hostAuth : controllerAuth);
  const keys = generateKeyPairSync('ed25519'), server = generateKeyPairSync('ed25519');
  const device = { id: randomUUID(), ownerUserId: 1, publicKey: keys.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    fingerprint: createHash('sha256').update(keys.publicKey.export({ format: 'der', type: 'spki' })).digest('hex'), keyVersion: 1, revokedAt: null };
  const signer = new RemoteCredentialSigner('test-flow', server.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), now - 1000, now + 7200000);
  const rows = new Map<string, RemoteSession>();
  const store = { get: async (id: string) => structuredClone(rows.get(id) || null),
    create: async (s: RemoteSession) => { rows.set(s.id, structuredClone(s)); return { created: true, session: s }; },
    save: async (previous: RemoteSession, next: RemoteSession) => { if (rows.get(previous.id)?.revision !== previous.revision) throw new RemoteControlError('REVISION_CONFLICT'); rows.set(next.id, structuredClone(next)); return next; } };
  const history = { prepareRequest: async (s: RemoteSession) => ({ created: true, sessionId: s.id, state: s.state }), assertAuthorized: async () => {}, archiveEnd: async () => {} };
  const service = new RemoteControlService(store, Date.now, history);
  const authority = new RemoteLiveAuthority({ authenticate: mocks.authenticate, device: async id => id === device.id ? device : null, released: async () => {} }, signer);
  const coordinator = new RemoteAuthorizationCoordinator(service, store, history, signer, authority);
  mocks.context = { authority, coordinator, service, store, history };
  mocks.grant.mockResolvedValue({ id: randomUUID(), createdBySid: hostAuth.sid });
  let middleware: Function, connected: Function;
  const namespace = { use: (fn: Function) => { middleware = fn; }, on: (_: string, fn: Function) => { connected = fn; },
    to: (id: string) => { const targets = new Set([id]); const room = { to: (id: string) => { targets.add(id); return room; }, emit: (event: string, value: unknown) => { sockets.filter(s => targets.has(s.id)).forEach(s => s.emit(event, value)); } }; return room; } };
  initializeRemoteControl({ of: () => namespace, engine: { once() {} } } as any);
  async function connect(auth: any) { const s = new Socket({ auth }); let error: any; await middleware!(s, (e: unknown) => { error = e; }); if (error) throw error; sockets.push(s); connected!(s); return s; }
  const host = await connect({ token: 'host', role: 'host', platform: 'macos', deviceId: device.id });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const challenge = JSON.parse(Buffer.from(host.last('remote:presence-challenge').proof.payload, 'base64url').toString());
  const signed = (body: unknown) => { const keyId = `device:${device.id}:1`, payload = Buffer.from(JSON.stringify(body)).toString('base64url');
    return { format: 'rc-signed-v1', keyId, payload, signature: sign(null, remoteSignatureMessage(keyId, payload), keys.privateKey).toString('base64url') }; };
  const presence = signed({ protocolVersion: 1, purpose: 'native-presence', host: host.data.remote.endpoint, challenge: challenge.challenge,
    platform: 'macos', engineDigest: 'ab'.repeat(32), canCapture: true, canControl: true, issuedAt: Date.now(), expiresAt: challenge.expiresAt });
  expect(await host.send('remote:presence', { proof: presence })).toEqual({ ok: true });
  const controller = await connect({ token: 'controller', role: 'controller', platform: 'web', controllerInstanceId: randomUUID() });
  const command = (socket: Socket, event: string, payload: unknown, id?: string) => socket.send(event, { protocolVersion: 1,
    requestId: randomUUID(), connectionGeneration: 1, payload, ...(id ? { sessionId: id, expectedRevision: rows.get(id)?.revision } : {}) });
  return { host, controller, command, signed, rows, signer, device };
}

describe('product namespace wiring using real coordinator and signatures', () => {
  it('routes request → native consent → offer/answer → native hello evidence → short lease; disconnect ends both peers', async () => {
    const f = await fixture();
    const requested = await f.command(f.controller, 'remote:request', { targetDeviceId: f.device.id, scope: 'control' });
    expect(requested.ok).toBe(true); const id = requested.sessionId;
    const approval = JSON.parse(Buffer.from(f.host.last('remote:approval').proof.payload, 'base64url').toString());
    const consentNonce = randomBytes(32).toString('base64url');
    const consent = f.signed({ protocolVersion: 1, purpose: 'host-consent', approvalId: approval.approvalId, action: 'accept',
      sessionId: id, host: approval.host, controller: approval.controller, requestedScope: 'control', decision: 'control',
      consentNonce, screenId: 'primary', authorizationRevision: 1, controlEpoch: 1, issuedAt: Date.now(), expiresAt: approval.expiresAt });
    expect((await f.command(f.host, 'remote:consent', { proof: consent }, id)).ok).toBe(true);
    const negotiation = f.controller.last('remote:connecting').negotiationId;
    const signal = (type: string, hex: string) => ({ type, negotiationId: negotiation, connectionGeneration: 1,
      sdp: `v=0\r\na=fingerprint:sha-256 ${Array(32).fill(hex).join(':')}\r\n` });
    expect((await f.command(f.controller, 'remote:signal', signal('offer', 'AA'), id)).ok).toBe(true);
    expect((await f.command(f.host, 'remote:signal', signal('answer', 'BB'), id)).ok).toBe(true);
    expect(f.controller.last('remote:connection-proof').proof).toEqual(f.host.last('remote:connection-proof').proof);
    const binding = { negotiationId: negotiation, controllerFingerprint: 'AA'.repeat(32), hostFingerprint: 'BB'.repeat(32) };
    expect((await f.command(f.controller, 'remote:ready', binding, id)).ok).toBe(true);
    expect(f.rows.get(id)?.state).toBe('connecting'); // A browser boolean/ACK does not authorize capture.
    const ready = { protocolVersion: 1, purpose: 'native-ready', host: approval.host, sessionId: id, ...binding,
      consentNonce, screenId: 'primary', authorizationRevision: 1, controlEpoch: 1, issuedAt: Date.now(), expiresAt: Date.now() + 10000 };
    expect((await f.command(f.host, 'remote:native-fact', { proof: f.signed(ready) }, id)).ok).toBe(true);
    expect(f.rows.get(id)?.state).toBe('active');
    expect((await f.command(f.host, 'remote:native-fact', { proof: f.signed({ ...ready, purpose: 'native-lease-challenge',
      challenge: randomBytes(32).toString('base64url'), leaseSeq: 1 }) }, id)).ok).toBe(true);
    const lease = f.controller.last('remote:lease').proof;
    expect(verifyRemoteCredential(lease, f.signer.publicKey, Date.now())).toMatchObject({ purpose: 'lease', scope: 'control', leaseSeq: 1 });
    expect((await f.command(f.controller, 'remote:pause', {}, id)).ok).toBe(true);
    expect((await f.command(f.controller, 'remote:control-request', {}, id)).ok).toBe(true);
    const restore = JSON.parse(Buffer.from(f.host.last('remote:approval').proof.payload, 'base64url').toString());
    const decline = f.signed({ protocolVersion: 1, purpose: 'host-consent', approvalId: restore.approvalId, action: 'grant-control',
      sessionId: id, host: restore.host, controller: restore.controller, requestedScope: 'control', decision: 'reject',
      consentNonce: randomBytes(32).toString('base64url'), screenId: 'primary', authorizationRevision: 3, controlEpoch: 3,
      issuedAt: Date.now(), expiresAt: restore.expiresAt });
    expect((await f.command(f.host, 'remote:consent', { proof: decline }, id)).ok).toBe(true);
    expect(f.controller.last('remote:control-approved')).toBeUndefined();
    expect((await f.command(f.host, 'remote:native-fact', { proof: f.signed({ ...ready, purpose: 'native-lease-challenge',
      challenge: randomBytes(32).toString('base64url'), leaseSeq: 2 }) }, id)).ok).toBe(true);
    expect(verifyRemoteCredential(f.controller.last('remote:lease').proof, f.signer.publicKey, Date.now())).toMatchObject({ scope: 'view', authorizationRevision: 2, controlEpoch: 2 });
    f.controller.disconnect(); for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(f.rows.get(id)?.state).toBe('ended'); expect(f.host.last('remote:ended').sessionId).toBe(id);
  });
  it('rejects client consent booleans and target requests without an explicit grant', async () => {
    const f = await fixture(); mocks.grant.mockResolvedValueOnce(null);
    expect(await f.command(f.controller, 'remote:request', { targetDeviceId: f.device.id, scope: 'view' })).toMatchObject({ ok: false, code: 'ASSISTANCE_GRANT_REQUIRED' });
    const result = await f.command(f.controller, 'remote:request', { targetDeviceId: f.device.id, scope: 'view' });
    expect(await f.command(f.host, 'remote:consent', { accepted: true }, result.sessionId)).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
    expect(f.rows.get(result.sessionId)?.state).toBe('pending');
  });
});

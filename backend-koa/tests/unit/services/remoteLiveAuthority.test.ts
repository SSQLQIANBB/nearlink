import { describe, it, expect } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'crypto';
import { RemoteCredentialSigner, remoteSignatureMessage } from '../../../src/services/remoteCredentials';
import { RemoteLiveAuthority } from '../../../src/services/remoteLiveAuthority';
import { verifyNativeSessionFact } from '../../../src/services/remoteNativeEvidence';
import type { RemoteSession } from '../../../src/services/remoteControlProtocol';

async function fixture() {
  let now = 1_800_000_000_000, revoked = false;
  const deviceKeys = generateKeyPairSync('ed25519'), server = generateKeyPairSync('ed25519');
  const device = { id: randomUUID(), ownerUserId: 1, publicKey: deviceKeys.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    fingerprint: createHash('sha256').update(deviceKeys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex'), keyVersion: 1, revokedAt: null as Date | null };
  const signer = new RemoteCredentialSigner('test-live', server.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), now - 1000, now + 7200000);
  const hostAuth = { userId: 1, sid: randomUUID(), authVersion: randomUUID(), username: 'host', exp: (now + 3600000) / 1000 };
  const controllerAuth = { ...hostAuth, userId: 2, username: 'controller', sid: randomUUID(), authVersion: randomUUID() };
  const authority = new RemoteLiveAuthority({ authenticate: async token => { if (revoked) throw new Error('AUTH_REVOKED'); return token === 'host' ? hostAuth : controllerAuth; },
    device: async id => id === device.id ? device : null, released: async () => {} }, signer, () => now);
  const host = await authority.connect('host', 'host-socket', device.id, 'host', 'macos');
  const controller = await authority.connect('controller', 'controller-socket', randomUUID(), 'controller', 'web');
  const signed = (body: unknown, key = deviceKeys.privateKey) => {
    const keyId = `device:${device.id}:${device.keyVersion}`, payload = Buffer.from(JSON.stringify(body)).toString('base64url');
    return { format: 'rc-signed-v1', keyId, payload, signature: sign(null, remoteSignatureMessage(keyId, payload), key).toString('base64url') };
  };
  async function presence(edits: Record<string, unknown> = {}) {
    const challenge = await authority.presenceChallenge(host);
    const claims = JSON.parse(Buffer.from(challenge.payload, 'base64url').toString());
    const body = { protocolVersion: 1, purpose: 'native-presence', host: host.endpoint, challenge: claims.challenge,
      engineDigest: 'ab'.repeat(32), platform: 'macos', canCapture: true, canControl: true, issuedAt: now, expiresAt: now + 30000, ...edits };
    return { body, proof: signed(body) };
  }
  const session: RemoteSession = { id: randomUUID(), requestId: randomUUID(), requestHash: '', grantId: randomUUID(),
    host: host.endpoint, controller: controller.endpoint, requestedScope: 'control', scope: 'control', state: 'connecting',
    revision: 1, authorizationRevision: 1, controlEpoch: 1, hostReady: false, controllerReady: false,
    createdAt: now, deadline: now + 30000, hardDeadline: now + 3600000 };
  return { authority, host, controller, device, session, signed, presence, now: () => now,
    advance: (ms: number) => { now += ms; }, revoke: () => { revoked = true; } };
}

describe('production live authority and native evidence', () => {
  it('does not expose a host until a fresh challenge-bound device signature is verified; consumes challenges', async () => {
    const f = await fixture(); expect(f.authority.host(f.device.id)).toBeUndefined();
    const p = await f.presence(); await f.authority.acceptPresence(f.host, p.proof);
    expect(f.authority.host(f.device.id)?.endpoint).toEqual(f.host.endpoint);
    await expect(f.authority.acceptPresence(f.host, p.proof)).rejects.toThrow('PRESENCE_CHALLENGE_REQUIRED');
    f.advance(30000); expect(f.authority.host(f.device.id)).toBeUndefined();
    await expect(f.authority.resolveConnection(f.host.handle)).rejects.toThrow('HOST_OFFLINE');
  });
  it.each(['purpose', 'connection', 'challenge', 'key', 'expired', 'permissions', 'unknown'])('rejects %s substitution before discovery', async change => {
    const f = await fixture(), p = await f.presence(); const body = structuredClone(p.body);
    let key;
    if (change === 'purpose') body.purpose = 'host-consent';
    if (change === 'connection') body.host = { ...f.host.endpoint, connectionId: 'different' };
    if (change === 'challenge') body.challenge = randomBytes(32).toString('base64url');
    if (change === 'key') key = generateKeyPairSync('ed25519').privateKey;
    if (change === 'expired') body.expiresAt = f.now();
    if (change === 'permissions') body.canCapture = false;
    if (change === 'unknown') Object.assign(body, { accepted: true });
    await expect(f.authority.acceptPresence(f.host, f.signed(body, key))).rejects.toThrow();
    expect(f.authority.host(f.device.id)).toBeUndefined();
  });
  it('revalidates durable login state and rejects stale handles after disconnect/reconnect', async () => {
    const f = await fixture(); await f.authority.acceptPresence(f.host, (await f.presence()).proof);
    f.revoke(); await expect(f.authority.assertCurrent(f.host.endpoint)).rejects.toThrow('AUTH_REVOKED');
    f.authority.disconnect(f.host); expect(f.authority.host(f.device.id)).toBeUndefined();
    await expect(f.authority.resolveConnection(f.host.handle)).rejects.toThrow('REMOTE_DISCONNECTED');
  });
  it('binds SDP from both authenticated endpoints and mints one-use handles only from signed native DTLS/hello evidence', async () => {
    const f = await fixture(); await f.authority.acceptPresence(f.host, (await f.presence()).proof);
    const id = f.authority.beginNegotiation(f.session);
    const sdp = (hex: string) => `v=0\r\na=fingerprint:sha-256 ${Array(32).fill(hex).join(':')}\r\n`;
    expect(() => f.authority.signal(f.session, f.host.endpoint, id, 'offer', sdp('AA'))).toThrow('SIGNAL_REJECTED');
    f.authority.signal(f.session, f.controller.endpoint, id, 'offer', sdp('AA'));
    f.authority.signal(f.session, f.host.endpoint, id, 'answer', sdp('BB'));
    expect(() => f.authority.signal(f.session, f.host.endpoint, id, 'answer', sdp('BB'))).toThrow('SDP_REPLAY');
    const active = { ...f.session, state: 'active' as const };
    expect(() => f.authority.signal(active, f.host.endpoint, id, 'candidate')).not.toThrow();
    expect(() => f.authority.signal(active, f.controller.endpoint, id, 'offer', sdp('AA'))).toThrow('NEGOTIATION_MISMATCH');
    const fact = { protocolVersion: 1, purpose: 'native-ready', host: f.host.endpoint, sessionId: f.session.id,
      ...await f.authority.negotiation(f.session), consentNonce: randomBytes(32).toString('base64url'), screenId: 'primary',
      authorizationRevision: 1, controlEpoch: 1, issuedAt: f.now(), expiresAt: f.now() + 10000 };
    await expect(f.authority.nativeFact(f.session, f.controller, f.signed(fact))).rejects.toThrow('HOST_REQUIRED');
    await expect(f.authority.consumeReady({ ...fact })).rejects.toThrow('READY_EVIDENCE_REQUIRED');
    const received = await f.authority.nativeFact(f.session, f.host, f.signed(fact));
    expect(received.type).toBe('ready');
    expect((await f.authority.consumeReady(received.handle)).endpoint).toEqual(f.host.endpoint);
    await expect(f.authority.consumeReady(received.handle)).rejects.toThrow('READY_EVIDENCE_REQUIRED');
    if (received.type === 'ready') expect((await f.authority.consumeReady(received.controllerHandle)).endpoint).toEqual(f.controller.endpoint);
    await expect(f.authority.nativeFact(f.session, f.host, f.signed({ ...fact, hostFingerprint: 'CC'.repeat(32) }))).rejects.toThrow('TRANSPORT_BINDING_CHANGED');
    const challenge = { ...fact, purpose: 'native-lease-challenge', leaseSeq: 1, challenge: randomBytes(32).toString('base64url') };
    const receipt = await f.authority.nativeFact(f.session, f.host, f.signed(challenge));
    expect((await f.authority.consumeNativeChallenge(receipt.handle)).leaseSeq).toBe(1);
    await expect(f.authority.consumeNativeChallenge(receipt.handle)).rejects.toThrow('NATIVE_CHALLENGE_REQUIRED');
    expect(() => verifyNativeSessionFact(f.signed({ ...fact, leaseSeq: 1 }), f.device, f.session, f.now())).toThrow();
    expect(() => verifyNativeSessionFact(f.signed({ ...challenge, controlEpoch: 0 }), f.device, f.session, f.now())).toThrow();
  });
  it('does not exceed registry capacity or replace an existing host in concurrent connects', async () => {
    const f = await fixture();
    await expect(f.authority.connect('host', 'other-socket', f.device.id, 'host', 'macos')).rejects.toThrow('DEVICE_ALREADY_ONLINE');
    f.authority.disconnect(f.host);
    const results = await Promise.allSettled(['new-1', 'new-2'].map(id => f.authority.connect('host', id, f.device.id, 'host', 'macos')));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  });
});

describe('主控连接设备证明', () => {
  async function boundFixture() {
    let now = 1_800_000_000_000, revokedLogin = false;
    const keys = generateKeyPairSync('ed25519'), server = generateKeyPairSync('ed25519');
    const device = { id: randomUUID(), ownerUserId: 2, keyVersion: 1, revokedAt: null as Date | null,
      fingerprint: createHash('sha256').update(keys.publicKey.export({ format: 'der', type: 'spki' })).digest('hex'), publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
    const sid = randomUUID(), authVersion = randomUUID();
    const signer = new RemoteCredentialSigner('test-server', server.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), now - 1000, now + 1000000);
    const authority = new RemoteLiveAuthority({ authenticate: async () => {
      if (revokedLogin) throw new Error('AUTH_REVOKED');
      return { userId: 2, sid, authVersion, exp: Math.floor((now + 100000) / 1000) } as any;
    }, device: async id => id === device.id ? device : null, released: async () => {} }, signer, () => now);
    const connection = await authority.connect('token', 'socket-a', randomUUID(), 'controller', 'macos', device.id);
    const proof = async (edit: (body: any) => void = () => {}) => {
      const challenge = await authority.controllerChallenge(connection);
      const c = JSON.parse(Buffer.from(challenge.payload, 'base64url').toString());
      const body = { protocolVersion: 1, purpose: 'native-controller-binding', controller: c.controller, deviceId: c.deviceId, challenge: c.challenge, issuedAt: now, expiresAt: c.expiresAt };
      edit(body);
      const keyId = `device:${device.id}:${device.keyVersion}`, payload = Buffer.from(JSON.stringify(body)).toString('base64url');
      return { format: 'rc-signed-v1', keyId, payload, signature: sign(null, remoteSignatureMessage(keyId, payload), keys.privateKey).toString('base64url') };
    };
    return { device, connection, authority, proof, advance: (ms: number) => { now += ms; }, revokeLogin: () => { revokedLogin = true; } };
  }
  it('声明设备但未验签不能创建会话，通过后持续检查撤销与密钥版本', async () => {
    const f = await boundFixture();
    await expect(f.authority.resolveConnection(f.connection.handle)).rejects.toThrow('CONTROLLER_DEVICE_PROOF_REQUIRED');
    const proof = await f.proof(); await f.authority.acceptController(f.connection, proof);
    expect(await f.authority.resolveConnection(f.connection.handle)).toEqual(f.connection.endpoint);
    await expect(f.authority.acceptController(f.connection, proof)).rejects.toThrow('CONTROLLER_CHALLENGE_REQUIRED');
    f.device.keyVersion++; await expect(f.authority.assertCurrent(f.connection.endpoint)).rejects.toThrow('CONTROLLER_DEVICE_REVOKED');
    f.device.keyVersion--; f.device.revokedAt = new Date();
    await expect(f.authority.assertCurrent(f.connection.endpoint)).rejects.toThrow('CONTROLLER_DEVICE_REVOKED');
  });
  it.each(['socket', 'sid', 'instance', 'nonce', 'purpose', 'device', 'scope'])('拒绝 %s 替换，失败证明不可重放', async variant => {
    const f = await boundFixture();
    const proof = await f.proof(body => {
      if (variant === 'socket') body.controller.connectionId = 'socket-b';
      if (variant === 'sid') body.controller.sid = randomUUID();
      if (variant === 'instance') body.controller.endpointId = randomUUID();
      if (variant === 'nonce') body.challenge = randomBytes(32).toString('base64url');
      if (variant === 'purpose') body.purpose = 'host-consent';
      if (variant === 'device') body.deviceId = randomUUID();
      if (variant === 'scope') body.scope = 'control';
    });
    await expect(f.authority.acceptController(f.connection, proof)).rejects.toThrow();
    await expect(f.authority.acceptController(f.connection, proof)).rejects.toThrow('CONTROLLER_CHALLENGE_REQUIRED');
    expect(f.connection.controllerDevice).toBeUndefined();
  });
  it('旧连接、过期证明、撤销登录都不能保持设备认证', async () => {
    const f = await boundFixture(); const proof = await f.proof(); f.advance(30001);
    await expect(f.authority.acceptController(f.connection, proof)).rejects.toThrow();
    await f.authority.acceptController(f.connection, await f.proof()); f.revokeLogin();
    await expect(f.authority.assertCurrent(f.connection.endpoint)).rejects.toThrow('AUTH_REVOKED');
    f.authority.disconnect(f.connection);
    await expect(f.authority.acceptController(f.connection, proof)).rejects.toThrow('REMOTE_DISCONNECTED');
    expect(f.connection.controllerDevice).toBeUndefined();
  });
});

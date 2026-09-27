import { describe, expect, it, vi } from 'vitest';
import { createHmac, generateKeyPairSync, randomUUID, verify } from 'crypto';
import { RemoteIceService, turnSettingsFromEnvironment } from '../../../src/services/remoteIce';
import { RemoteCredentialSigner, remoteSignatureMessage, verifyRemoteCredential } from '../../../src/services/remoteCredentials';
import { RemoteControlError, type RemoteEndpoint, type RemoteSession } from '../../../src/services/remoteControlProtocol';

function fixture() {
  let now = 1_700_000_000_123;
  const endpoint = (userId: number): RemoteEndpoint => ({ userId, sid: randomUUID(), authVersion: randomUUID(), endpointId: randomUUID(), connectionId: randomUUID(), generation: 1 });
  const session: RemoteSession = { id: randomUUID(), requestId: randomUUID(), requestHash: 'hash', grantId: randomUUID(),
    host: endpoint(1), controller: endpoint(2), state: 'connecting', requestedScope: 'view', scope: 'view', revision: 2,
    authorizationRevision: 1, controlEpoch: 1, hostReady: false, controllerReady: false,
    createdAt: now, deadline: now + 30000, hardDeadline: now + 3_600_000 };
  const pair = generateKeyPairSync('ed25519');
  const signer = new RemoteCredentialSigner('test', pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), now - 1, now + 4_000_000);
  const store = { get: vi.fn(async () => structuredClone(session) as RemoteSession | null) };
  const authority = { assertAuthorized: vi.fn(async (_session: RemoteSession) => {}) };
  const settings = turnSettingsFromEnvironment({ REMOTE_TURN_SHARED_SECRET: 'test-only-secret'.repeat(4) });
  if (settings.authMode === 'static') throw new Error('Expected REST fixture');
  const service = new RemoteIceService(store, authority, () => settings, () => signer, () => now);
  return { session, store, authority, settings, signer, pair, service, advance: (ms: number) => { now += ms; } };
}
describe('会话TURN短期凭据', () => {
  it('仅显式静态认证模式复用旧视频TURN；仍校验会话并签名配置', async () => {
    const f = fixture();
    const settings = turnSettingsFromEnvironment({ REMOTE_TURN_AUTH_MODE: 'static', REMOTE_TURN_USERNAME: 'video-user', REMOTE_TURN_PASSWORD: 'test-only-password' });
    const service = new RemoteIceService(f.store, f.authority, () => settings, () => f.signer, () => f.session.createdAt);
    const result = await service.issue(f.session.id, f.session.host);
    expect(result.iceServers[1]).toMatchObject({ username: 'video-user', credential: 'test-only-password' });
    expect(verify(null, remoteSignatureMessage(result.proof.keyId, result.proof.payload), f.pair.publicKey, Buffer.from(result.proof.signature, 'base64url'))).toBe(true);
    f.authority.assertAuthorized.mockRejectedValue(new RemoteControlError('AUTH_REVOKED', 401));
    await expect(service.issue(f.session.id, f.session.host)).rejects.toMatchObject({ code: 'AUTH_REVOKED' });
    expect(() => turnSettingsFromEnvironment({ REMOTE_TURN_USERNAME: 'video-user', REMOTE_TURN_PASSWORD: 'test-only-password' })).toThrow('REMOTE_ICE_UNCONFIGURED');
    expect(() => turnSettingsFromEnvironment({ REMOTE_TURN_AUTH_MODE: 'static', REMOTE_TURN_USERNAME: 'video-user' })).toThrow('REMOTE_ICE_UNCONFIGURED');
    expect(() => turnSettingsFromEnvironment({ REMOTE_TURN_AUTH_MODE: 'auto' })).toThrow('REMOTE_ICE_CONFIGURATION_INVALID');
  });
  it('复用视频TURN地址，使用coturn REST HMAC，签名同时绑定会话与两端身份', async () => {
    const f = fixture(), r = await f.service.issue(f.session.id, f.session.host);
    const turn = r.iceServers[1]!;
    expect(turn.urls).toEqual(['turn:turn.sycsq.top:3478?transport=udp', 'turn:turn.sycsq.top:3478?transport=tcp']);
    expect(turn.credential).toBe(createHmac('sha1', f.settings.secret).update(turn.username!).digest('base64'));
    expect(Number(turn.username!.split(':')[0]) * 1000).toBe(r.expiresAt);
    expect(r.expiresAt).toBe(Math.floor((f.session.hardDeadline + 300000) / 1000) * 1000);
    expect(verify(null, remoteSignatureMessage(r.proof.keyId, r.proof.payload), f.pair.publicKey, Buffer.from(r.proof.signature, 'base64url'))).toBe(true);
    const claims = JSON.parse(Buffer.from(r.proof.payload, 'base64url').toString());
    expect(claims).toMatchObject({ audience: 'todesk-native-ice', purpose: 'ice-config', sessionId: f.session.id, host: f.session.host, controller: f.session.controller });
    expect(JSON.stringify(r)).not.toContain(f.settings.secret);
    expect(turn.username).not.toContain(f.session.host.sid);
    expect(() => verifyRemoteCredential(r.proof, f.signer.publicKey, f.session.createdAt)).toThrow();
    expect(f.authority.assertAuthorized).toHaveBeenCalledOnce();
  });
  it('重试不延长有效期；不同端使用不同中继用户名；relay模式不发STUN', async () => {
    const f = fixture(), first = await f.service.issue(f.session.id, f.session.host);
    f.advance(1000);
    const second = await f.service.issue(f.session.id, f.session.host);
    const controller = await f.service.issue(f.session.id, f.session.controller);
    expect(second.iceServers).toEqual(first.iceServers); expect(second.expiresAt).toBe(first.expiresAt);
    expect(controller.iceServers[1]!.username).not.toBe(first.iceServers[1]!.username);
    f.settings.policy = 'relay';
    const relay = await f.service.issue(f.session.id, f.session.host);
    expect(relay.iceTransportPolicy).toBe('relay'); expect(relay.iceServers).toHaveLength(1);
  });
  it.each(['userId', 'sid', 'authVersion'] as const)('相同账号的其他登录也不能冒用会话：%s', async field => {
    const f = fixture(); const auth = { ...f.session.host, [field]: field === 'userId' ? 99 : randomUUID() };
    await expect(f.service.issue(f.session.id, auth)).rejects.toMatchObject({ code: 'NOT_A_PARTICIPANT', status: 403 });
    expect(f.authority.assertAuthorized).not.toHaveBeenCalled();
  });
  it.each(['pending', 'ended', 'expired', 'unapproved'] as const)('拒绝不可签发状态：%s', async state => {
    const f = fixture();
    if (state === 'expired') f.advance(30000);
    else if (state === 'unapproved') f.session.authorizationRevision = 0;
    else f.session.state = state;
    await expect(f.service.issue(f.session.id, f.session.host)).rejects.toMatchObject({ code: 'REMOTE_ICE_SESSION_UNAVAILABLE' });
  });
  it('数据库授权撤销或检查期间会话结束均不发凭据', async () => {
    const f = fixture(); f.authority.assertAuthorized.mockRejectedValueOnce(new RemoteControlError('AUTH_REVOKED', 401));
    await expect(f.service.issue(f.session.id, f.session.host)).rejects.toMatchObject({ code: 'AUTH_REVOKED' });
    f.authority.assertAuthorized.mockImplementationOnce(async () => { f.session.state = 'ended'; });
    await expect(f.service.issue(f.session.id, f.session.host)).rejects.toMatchObject({ code: 'REMOTE_ICE_SESSION_UNAVAILABLE' });
  });
  it('检查期间连接换代/修订变化不发旧绑定凭据', async () => {
    const f = fixture(); f.authority.assertAuthorized.mockImplementationOnce(async () => { f.session.host.generation++; });
    await expect(f.service.issue(f.session.id, f.session.host)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    f.authority.assertAuthorized.mockImplementationOnce(async () => { f.session.revision++; });
    await expect(f.service.issue(f.session.id, f.session.host)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    f.store.get.mockResolvedValue(null);
    await expect(f.service.issue(f.session.id, f.session.host)).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });
  it('部署缺少共享密钥或签名窗口不足时明确失败，不回退到视频固定密码', async () => {
    expect(() => turnSettingsFromEnvironment({})).toThrow('REMOTE_ICE_UNCONFIGURED');
    const f = fixture();
    const missing = new RemoteIceService(f.store, f.authority, () => f.settings, () => null, () => f.session.createdAt);
    await expect(missing.issue(f.session.id, f.session.host)).rejects.toMatchObject({ code: 'REMOTE_SIGNING_UNAVAILABLE' });
    const short = new RemoteCredentialSigner('short', f.pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), f.session.createdAt, f.session.hardDeadline);
    const service = new RemoteIceService(f.store, f.authority, () => f.settings, () => short, () => f.session.createdAt);
    await expect(service.issue(f.session.id, f.session.host)).rejects.toMatchObject({ code: 'REMOTE_ICE_SIGNING_WINDOW' });
  });
  it.each(['turn:user:password@host:3478?transport=udp', 'turn:host:65536?transport=tcp', 'turns:host:5349?transport=udp',
    'turn:host:3478', 'turn:bad..host:3478?transport=udp', 'https://host:443', 'turn:host:3478?transport=udp#secret'])('拒绝错误URL：%s', url => {
    expect(() => turnSettingsFromEnvironment({ REMOTE_TURN_SHARED_SECRET: 'test'.repeat(16), REMOTE_TURN_URLS: url })).toThrow('REMOTE_ICE_CONFIGURATION_INVALID');
  });
});

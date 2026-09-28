import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'crypto';
const mocks = vi.hoisted(() => ({ context: null as any, validate: vi.fn() }));
vi.mock('../../../src/services/remoteControlContext', () => ({ getRemoteControlContext: () => mocks.context }));
vi.mock('../../../src/services/loginSessionService', () => ({ validateAuthenticatedSession: mocks.validate }));
vi.mock('../../../src/models/RemoteControl', () => ({ AssistanceGrant: {} }));
import { initializeRemoteControl } from '../../../src/config/remoteControl';
import { RemoteLiveAuthority } from '../../../src/services/remoteLiveAuthority';
import { RemoteCredentialSigner, remoteSignatureMessage } from '../../../src/services/remoteCredentials';
beforeEach(() => { vi.useFakeTimers(); vi.stubEnv('REMOTE_CONTROL_PREVIEW_USER_IDS', '2'); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); });
async function setup() {
  const key = generateKeyPairSync('ed25519'), server = generateKeyPairSync('ed25519');
  const device = { id: randomUUID(), ownerUserId: 2, revokedAt: null as Date | null, keyVersion: 1,
    publicKey: key.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    fingerprint: createHash('sha256').update(key.publicKey.export({ type: 'spki', format: 'der' })).digest('hex') };
  mocks.validate.mockResolvedValue({ userId: 2, sid: randomUUID(), authVersion: randomUUID(), exp: Math.floor(Date.now()/1000)+3600 });
  const authority = new RemoteLiveAuthority({ authenticate: mocks.validate, device: async () => device, released: async () => {} },
    new RemoteCredentialSigner('server', server.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), Date.now()-1000, Date.now()+3600000));
  mocks.context = { authority, coordinator: {}, service: { subscribe: () => () => {}, end: vi.fn() }, store: {}, history: {} };
  let middleware: any, connected: any;
  const namespace: any = { use: (fn: any) => { middleware = fn; }, on: (_: string, fn: any) => { connected = fn; }, to: () => namespace, emit: vi.fn() };
  initializeRemoteControl({ of: () => namespace, engine: { once: vi.fn() } } as any);
  const events = new Map<string, any>();
  const socket: any = { id: 'test-controller-socket', data: {}, conn: { readyState: 'open' }, emit: vi.fn(),
    handshake: { auth: { token: 'token', role: 'controller', platform: 'macos', controllerInstanceId: randomUUID(), controllerDeviceId: device.id } },
    on: (name: string, callback: any) => events.set(name, callback), disconnect: vi.fn(() => events.get('disconnect')?.()) };
  const next = vi.fn(); await middleware(socket, next); expect(next).toHaveBeenCalledWith(); connected(socket);
  const send = async (event: string, data: unknown) => { const ack = vi.fn(); await events.get(event)(data, ack); return ack.mock.calls[0][0]; };
  const request = () => send('remote:request', { protocolVersion: 1, requestId: randomUUID(), connectionGeneration: 1, payload: { targetDeviceId: randomUUID(), scope: 'view' } });
  const bind = async () => {
    const challenge = await send('remote:controller-challenge', {}); expect(challenge.ok).toBe(true);
    const c = JSON.parse(Buffer.from(challenge.proof.payload, 'base64url').toString());
    const payload = Buffer.from(JSON.stringify({ protocolVersion: 1, purpose: 'native-controller-binding', controller: c.controller,
      deviceId: c.deviceId, challenge: c.challenge, issuedAt: Date.now(), expiresAt: c.expiresAt })).toString('base64url');
    const keyId = `device:${device.id}:1`;
    return send('remote:controller-proof', { proof: { format: 'rc-signed-v1', keyId, payload, signature: sign(null, remoteSignatureMessage(keyId, payload), key.privateKey).toString('base64url') } });
  };
  return { socket, request, bind, send, device };
}
describe('主控设备 Socket 接线', () => {
  it('请求前强制完成设备验签，撤销设备触发连接断开', async () => {
    const f = await setup(); expect((await f.request()).code).toBe('CONTROLLER_DEVICE_PROOF_REQUIRED');
    expect(await f.bind()).toEqual({ ok: true });
    // Passes controller identity, then fails because there is intentionally no host.
    expect((await f.request()).code).toBe('HOST_UNAVAILABLE');
    f.device.revokedAt = new Date(); await vi.advanceTimersByTimeAsync(5000);
    expect(f.socket.disconnect).toHaveBeenCalled();
  });
  it('不提交证明的连接超时关闭；额外字段不能绕过认证', async () => {
    const f = await setup(); await vi.advanceTimersByTimeAsync(30000); expect(f.socket.disconnect).toHaveBeenCalled();
    const g = await setup(); expect(await g.send('remote:controller-challenge', { accepted: true })).toEqual({ ok: false, code: 'CONTROLLER_DEVICE_PROOF_REJECTED' });
    expect(g.socket.disconnect).toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => mocks);
import { identifyRemoteDevice, validIdentityChallenge, cancelRemoteNativeOperation, confirmRemoteNativeRequest, createRemoteDeviceProof, probeRemoteDeviceSupport, resetRemoteDeviceIdentity, validDeviceChallenge } from '@/services/remoteDeviceNative';
import { clearRemoteControlLocally } from '@/services/remoteControlSafety';
const challenge = () => ({ id: '11111111-1111-4111-8111-111111111111', nonce: 'A'.repeat(43), userId: 1, sid: '22222222-2222-4222-8222-222222222222', action: 'register-device' as const, expiresAt: Date.now() + 29000 });
const proof = () => ({ challengeId: challenge().id, publicKey: '-----BEGIN PUBLIC KEY-----\npublic\n-----END PUBLIC KEY-----\n', signature: `${'A'.repeat(86)}==`, alias: '办公电脑', platform: 'macos' });
const envelope = { format: 'rc-signed-v1' as const, keyId: 'production:1', payload: 'e30', signature: 'A'.repeat(86) };
beforeEach(async () => {
  mocks.isTauri.mockReturnValue(true); mocks.invoke.mockResolvedValue(undefined);
  await cancelRemoteNativeOperation(); vi.clearAllMocks();
});
describe('设备身份与OS授权桥', () => {
  it('识别使用独立命令，不携带别名或调用登记，验证挑战用途', async () => {
    const input = { ...challenge(), action: 'identify-device' as const };
    const { alias: _, ...identityProof } = proof(); mocks.invoke.mockResolvedValue(identityProof);
    expect(validIdentityChallenge(input, 1, input.sid)).toBe(true);
    expect(validIdentityChallenge(challenge() as any, 1, input.sid)).toBe(false);
    expect(await identifyRemoteDevice(input, new AbortController().signal)).toEqual(identityProof);
    expect(mocks.invoke).toHaveBeenCalledWith('remote_control_identify_device', { challenge: input });
  });
  it('Web和缺少新能力的旧桌面都不能登记；检测不会创建密钥', async () => {
    mocks.isTauri.mockReturnValue(false);
    expect(await probeRemoteDeviceSupport()).toMatchObject({ desktop: false, registration: false });
    expect(mocks.invoke).not.toHaveBeenCalled();
    await expect(createRemoteDeviceProof(challenge(), '办公电脑', new AbortController().signal)).rejects.toThrow('DESKTOP_REQUIRED');
    mocks.isTauri.mockReturnValue(true); mocks.invoke.mockResolvedValue({ runtime: 'tauri', protocolVersion: 1, platform: 'macos', engineReady: false });
    expect(await probeRemoteDeviceSupport()).toMatchObject({ desktop: true, registration: false, consent: false });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
  it('登记能力独立于远控发布与引擎，不以其开启控制', async () => {
    mocks.invoke.mockResolvedValue({ runtime: 'tauri', protocolVersion: 1, platform: 'macos', engineReady: false, deviceRegistrationReady: true, consentPromptReady: false });
    expect(await probeRemoteDeviceSupport()).toEqual({ desktop: true, platform: 'macos', registration: true, identityReset: false, identification: false, consent: false });
  });
  it('只调用限定用途登记命令，结果只含公钥和proof', async () => {
    const input = challenge(); mocks.invoke.mockResolvedValue(proof());
    expect(await createRemoteDeviceProof(input, '办公电脑', new AbortController().signal)).toEqual(proof());
    expect(mocks.invoke).toHaveBeenCalledWith('remote_control_register_device', { challenge: input, alias: '办公电脑' });
  });
  it('错误身份/过期/未知字段的挑战无效', () => {
    const input = challenge();
    expect(validDeviceChallenge(input, 1, input.sid)).toBe(true);
    expect(validDeviceChallenge(input, 2, input.sid)).toBe(false);
    expect(validDeviceChallenge({ ...input, expiresAt: Date.now() }, 1, input.sid)).toBe(false);
    expect(validDeviceChallenge({ ...input, accepted: true } as any, 1, input.sid)).toBe(false);
  });
  it('取消期间的迟到本机签名被丢弃，并执行原生stop', async () => {
    let resolve!: (value: unknown) => void;
    mocks.invoke.mockImplementation(command => command === 'remote_control_register_device' ? new Promise(done => { resolve = done; }) : Promise.resolve());
    const abort = new AbortController();
    const pending = createRemoteDeviceProof(challenge(), '办公电脑', abort.signal);
    await flushPromises();
    const rejected = expect(pending).rejects.toThrow('REMOTE_OPERATION_CANCELLED');
    abort.abort(); await rejected;
    expect(mocks.invoke).toHaveBeenCalledWith('remote_control_stop');
    resolve(proof()); await flushPromises();
  });
  it('只转交签名请求给OS，Vue不能传accepted或keyring', async () => {
    mocks.invoke.mockResolvedValue({ consent: envelope });
    expect(await confirmRemoteNativeRequest(envelope, new AbortController().signal)).toEqual(envelope);
    expect(mocks.invoke).toHaveBeenCalledWith('remote_control_confirm_request', { request: envelope });
    await expect(confirmRemoteNativeRequest({ ...envelope, accepted: true } as any, new AbortController().signal)).rejects.toThrow('REMOTE_REQUEST_INVALID');
  });
  it('重建只传账号，取消由OS结果决定，不允许Vue强制确认', async () => {
    mocks.invoke.mockResolvedValueOnce({ reset: false }).mockResolvedValueOnce({ reset: true });
    expect(await resetRemoteDeviceIdentity(1, new AbortController().signal)).toBe(false);
    expect(await resetRemoteDeviceIdentity(1, new AbortController().signal)).toBe(true);
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'remote_control_reset_identity', { userId: 1 });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'remote_control_reset_identity', { userId: 1 });
  });
  it('同一微任务内的并发原生命令不能同时等待系统授权', async () => {
    mocks.invoke.mockResolvedValue(proof());
    const first = createRemoteDeviceProof(challenge(), '办公电脑', new AbortController().signal);
    await expect(createRemoteDeviceProof(challenge(), '办公电脑', new AbortController().signal)).rejects.toThrow('REMOTE_NATIVE_BUSY');
    await first; expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
  it('账号注销会中断等待OS决定，迟到的同意不会返还给传输层', async () => {
    let resolve!: (value: unknown) => void;
    mocks.invoke.mockImplementation(command => command === 'remote_control_confirm_request' ? new Promise(done => { resolve = done; }) : Promise.resolve());
    const pending = confirmRemoteNativeRequest(envelope, new AbortController().signal); await flushPromises();
    const rejected = expect(pending).rejects.toThrow('REMOTE_OPERATION_CANCELLED');
    clearRemoteControlLocally('LOGOUT'); await rejected;
    resolve({ consent: envelope }); await flushPromises();
    expect(mocks.invoke).toHaveBeenCalledWith('remote_control_stop');
  });
});

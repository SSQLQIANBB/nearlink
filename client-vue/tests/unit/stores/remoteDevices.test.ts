import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';
const mocks = vi.hoisted(() => ({
  auth: { token: '', currentUser: { id: 1 }, authGeneration: 1, loggingOut: false },
  identityChallenge: vi.fn(), identify: vi.fn(), verifyIdentity: vi.fn(), list: vi.fn(), challenge: vi.fn(), register: vi.fn(), rename: vi.fn(), revoke: vi.fn(), probe: vi.fn(), proof: vi.fn(), rebuild: vi.fn(),
}));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => mocks.auth }));
vi.mock('@/api/remoteControl', () => ({ getRemoteIdentityChallenge: mocks.identityChallenge, verifyRemoteIdentity: mocks.verifyIdentity, getRemoteDevices: mocks.list, getRemoteDeviceChallenge: mocks.challenge, registerRemoteDevice: mocks.register, revokeRemoteDevice: mocks.revoke, renameRemoteDevice: mocks.rename }));
vi.mock('@/services/remoteDeviceNative', async original => ({ ...await original<typeof import('@/services/remoteDeviceNative')>(), identifyRemoteDevice: mocks.identify, probeRemoteDeviceSupport: mocks.probe, createRemoteDeviceProof: mocks.proof, resetRemoteDeviceIdentity: mocks.rebuild }));
import { useRemoteDevicesStore } from '@/stores/remoteDevices';
import { clearRemoteControlLocally } from '@/services/remoteControlSafety';
const sid = '22222222-2222-4222-8222-222222222222';
const token = (userId = 1, value = sid) => `header.${btoa(JSON.stringify({ userId, sid: value }))}.signature`;
const device = { deviceId: '11111111-1111-4111-8111-111111111111', alias: '办公电脑', platform: 'macos' as const, revokedAt: null, createdAt: new Date().toISOString() };
function deferred<T = any>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  clearRemoteControlLocally('TEST_RESET'); setActivePinia(createPinia()); vi.clearAllMocks();
  Object.assign(mocks.auth, { token: token(), currentUser: { id: 1 }, authGeneration: 1, loggingOut: false });
  mocks.list.mockResolvedValue({ devices: [] }); mocks.probe.mockResolvedValue({ desktop: true, registration: true, identityReset: true, consent: false, platform: 'macos' });
  mocks.challenge.mockImplementation(async () => ({ challenge: { id: device.deviceId, nonce: 'A'.repeat(43), userId: 1, sid, action: 'register-device', expiresAt: Date.now() + 29000 } }));
  mocks.proof.mockResolvedValue({ challengeId: device.deviceId, alias: device.alias, platform: 'macos', publicKey: 'public', signature: 'signature' });
  mocks.register.mockResolvedValue({ device }); mocks.revoke.mockResolvedValue({ ok: true });
});
async function setup() { const store = useRemoteDevicesStore(); await store.initialize(); return store; }
describe('本人远程设备管理', () => {
  it('登记按挑战→原生限定proof→POST，不捏造在线/可控状态', async () => {
    const store = await setup(); expect(await store.register(' 办公电脑 ')).toBe(true);
    expect(mocks.register).toHaveBeenCalledWith(await mocks.proof.mock.results[0]!.value, expect.any(AbortSignal));
    expect(store.devices).toEqual([device]); expect(store.devices[0]).not.toHaveProperty('online');
    expect(store.notice).toContain('不会开启');
  });
  it('Web可查已有设备，但不能创建登记挑战或原生签名', async () => {
    mocks.probe.mockResolvedValue({ desktop: false, registration: false }); mocks.list.mockResolvedValue({ devices: [device] });
    const store = await setup(); expect(store.devices).toEqual([device]);
    expect(await store.register('电脑')).toBe(false); expect(mocks.challenge).not.toHaveBeenCalled();
  });
  it('取消后迟到challenge不能触发本机密钥操作', async () => {
    const wait = deferred(); mocks.challenge.mockReturnValue(wait.promise);
    const store = await setup(); const pending = store.register('办公电脑'); store.cancel();
    wait.resolve({ challenge: {} }); expect(await pending).toBe(false);
    expect(mocks.proof).not.toHaveBeenCalled(); expect(mocks.register).not.toHaveBeenCalled();
  });
  it('取消等待本机签名立即abort，迟到proof不能POST', async () => {
    const wait = deferred(); mocks.proof.mockReturnValue(wait.promise);
    const store = await setup(); const pending = store.register('办公电脑'); await flushPromises();
    const signal = mocks.proof.mock.calls[0]![2]; store.cancel(); expect(signal.aborted).toBe(true);
    wait.resolve({}); expect(await pending).toBe(false); expect(mocks.register).not.toHaveBeenCalled();
  });
  it('注销或账号切换后旧proof不得使用新账号token提交', async () => {
    const wait = deferred(); mocks.proof.mockReturnValue(wait.promise);
    const store = await setup(); const pending = store.register('办公电脑'); await flushPromises();
    mocks.auth.authGeneration++; mocks.auth.token = token(2); mocks.auth.currentUser = { id: 2 };
    clearRemoteControlLocally('AUTH_REPLACED'); wait.resolve({});
    expect(await pending).toBe(false); expect(mocks.register).not.toHaveBeenCalled(); expect(store.devices).toEqual([]);
  });
  it('即使遗漏cleanup，authGeneration/sid变化仍阻止提交', async () => {
    const wait = deferred(); mocks.proof.mockReturnValue(wait.promise);
    const store = await setup(); const pending = store.register('办公电脑'); await flushPromises();
    mocks.auth.token = token(1, '33333333-3333-4333-8333-333333333333'); wait.resolve({});
    expect(await pending).toBe(false); expect(mocks.register).not.toHaveBeenCalled();
  });
  it('POST之后取消不会声称回滚，旧成功不能污染新账号设备', async () => {
    const wait = deferred(); mocks.register.mockReturnValue(wait.promise);
    const store = await setup(); const pending = store.register('办公电脑'); await flushPromises(); store.cancel();
    expect(store.notice).toContain('可能已提交'); expect(mocks.register.mock.calls[0]![1].aborted).toBe(true);
    mocks.auth.authGeneration++; mocks.auth.token = token(2); mocks.auth.currentUser = { id: 2 };
    mocks.list.mockResolvedValue({ devices: [{ ...device, alias: '新账号设备' }] }); await store.refresh();
    wait.resolve({ device }); expect(await pending).toBe(false); expect(store.devices[0]!.alias).toBe('新账号设备');
  });
  it('前一次列表响应不能覆盖刷新/撤销后的设备', async () => {
    const store = await setup(); store.devices = [device];
    const wait = deferred(); mocks.list.mockReturnValueOnce(wait.promise).mockResolvedValueOnce({ devices: [{ ...device, revokedAt: new Date().toISOString() }] });
    const old = store.refresh(); expect(await store.revoke(device.deviceId)).toBe(true);
    wait.resolve({ devices: [device] }); await old;
    expect(store.devices[0]!.revokedAt).not.toBeNull(); expect(mocks.revoke).toHaveBeenCalledWith(device.deviceId, expect.any(AbortSignal));
  });
  it('挑战身份不匹配时不调用native；网络失败不自动重放登记', async () => {
    const store = await setup(); mocks.challenge.mockResolvedValue({ challenge: { userId: 2 } });
    expect(await store.register('办公电脑')).toBe(false); expect(mocks.proof).not.toHaveBeenCalled();
    mocks.challenge.mockRejectedValue(new Error('offline')); expect(await store.register('办公电脑')).toBe(false);
    expect(mocks.challenge).toHaveBeenCalledTimes(2); expect(mocks.register).not.toHaveBeenCalled();
  });
  it('已撤销key只有显式OS确认重建后才允许重新登记，不自动继承许可', async () => {
    const store = await setup(); mocks.register.mockRejectedValueOnce(new Error('DEVICE_KEY_UNAVAILABLE'));
    expect(await store.register('办公电脑')).toBe(false); expect(store.identityUnavailable).toBe(true);
    expect(mocks.rebuild).not.toHaveBeenCalled(); expect(await store.register('办公电脑')).toBe(false);
    mocks.rebuild.mockResolvedValueOnce(false); expect(await store.rebuildIdentity()).toBe(false);
    expect(store.identityUnavailable).toBe(true); expect(mocks.challenge).toHaveBeenCalledTimes(1);
    mocks.rebuild.mockResolvedValueOnce(true); expect(await store.rebuildIdentity()).toBe(true);
    expect(store.identityUnavailable).toBe(false); expect(mocks.rebuild).toHaveBeenCalledWith(1, expect.any(AbortSignal));
    expect(mocks.challenge).toHaveBeenCalledTimes(1); expect(store.notice).toContain('不会继承');
    expect(await store.register('办公电脑')).toBe(true);
  });
  it('注销时中止重建等待，新账号不接收旧身份结果', async () => {
    const store = await setup(); store.identityUnavailable = true;
    const wait = deferred(); mocks.rebuild.mockReturnValue(wait.promise); const pending = store.rebuildIdentity();
    mocks.auth.loggingOut = true; mocks.auth.authGeneration++; clearRemoteControlLocally('LOGOUT');
    expect(mocks.rebuild.mock.calls[0]![1].aborted).toBe(true);
    wait.resolve(true); expect(await pending).toBe(false); expect(store.notice).toBe(''); expect(store.support).toBeNull();
  });
});

describe('设备重命名', () => {
  it('Web可改名，旧列表不能覆盖新名称', async () => {
    mocks.probe.mockResolvedValue({ desktop: false, registration: false });
    const store = await setup(); store.devices = [device];
    const wait = deferred(); mocks.list.mockReturnValueOnce(wait.promise);
    const old = store.refresh(); mocks.rename.mockResolvedValue({ device: { ...device, alias: '新名称' } });
    expect(await store.rename(device.deviceId, ' 新名称 ')).toBe(true);
    wait.resolve({ devices: [device] }); await old;
    expect(store.devices[0]!.alias).toBe('新名称');
    expect(mocks.rename).toHaveBeenCalledWith(device.deviceId, '新名称', expect.any(AbortSignal));
    expect(mocks.proof).not.toHaveBeenCalled();
  });
  it('取消、退出账号后迟到结果不会恢复旧设备', async () => {
    const store = await setup(); store.devices = [device];
    const wait = deferred(); mocks.rename.mockReturnValueOnce(wait.promise);
    const pending = store.rename(device.deviceId, '新名称'); store.cancel();
    expect(store.notice).toContain('可能已保存');
    clearRemoteControlLocally('LOGOUT'); wait.resolve({ device });
    expect(await pending).toBe(false); expect(store.devices).toEqual([]);
  });
  it('无效名称或撤销设备不会提交，失败可重试', async () => {
    const store = await setup(); store.devices = [device];
    for (const name of [' ', 'a'.repeat(81), 'a\u0000b']) expect(await store.rename(device.deviceId, name)).toBe(false);
    store.devices = [{ ...device, revokedAt: '2026-09-28' }];
    expect(await store.rename(device.deviceId, '名称')).toBe(false); expect(mocks.rename).not.toHaveBeenCalled();
    store.devices = [device]; mocks.rename.mockRejectedValueOnce(new Error('offline'));
    expect(await store.rename(device.deviceId, '名称')).toBe(false); expect(store.busy).toBe(false); expect(store.error).toContain('刷新');
  });
});

describe('本机设备识别', () => {
  async function ready() {
    const store = await setup(); store.support!.identification = true;
    mocks.identityChallenge.mockResolvedValue({ challenge: { id: device.deviceId, nonce: 'A'.repeat(43), userId: 1, sid, action: 'identify-device', expiresAt: Date.now() + 29000 } });
    mocks.identify.mockResolvedValue({ proof: 'native' }); mocks.verifyIdentity.mockResolvedValue({ device });
    return store;
  }
  it('验证后标记本机，不创建新登记或发起远控', async () => {
    const store = await ready(); expect(await store.identify()).toBe(true);
    expect(store.localDeviceId).toBe(device.deviceId); expect(store.devices).toEqual([device]);
    expect(mocks.register).not.toHaveBeenCalled(); expect(store.notice).toContain('不会开启');
    mocks.list.mockResolvedValue({ devices: [{ ...device, revokedAt: '2026-09-28' }] });
    await store.refresh(); expect(store.localDeviceId).toBeNull();
  });
  it('账号切换后的旧识别证明不向新账号提交', async () => {
    const store = await ready(); const wait = deferred(); mocks.identify.mockReturnValueOnce(wait.promise);
    const pending = store.identify(); await flushPromises();
    mocks.auth.authGeneration++; clearRemoteControlLocally('AUTH_REPLACED'); wait.resolve({ proof: 'old' });
    expect(await pending).toBe(false); expect(mocks.verifyIdentity).not.toHaveBeenCalled(); expect(store.localDeviceId).toBeNull();
  });
  it('取消或失败不保留本机标记，旧客户端不签名', async () => {
    const store = await ready(); const wait = deferred(); mocks.verifyIdentity.mockReturnValueOnce(wait.promise);
    const pending = store.identify(); await flushPromises(); store.cancel(); wait.resolve({ device });
    expect(await pending).toBe(false); expect(store.localDeviceId).toBeNull();
    mocks.identify.mockRejectedValueOnce(new Error('no key')); expect(await store.identify()).toBe(false);
    expect(store.error).toContain('未能识别'); store.support!.identification = false;
    expect(await store.identify()).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';
const mocks = vi.hoisted(() => ({
  auth: { token: '', currentUser: { id: 1 }, authGeneration: 1, loggingOut: false },
  challenge: vi.fn(),
  register: vi.fn(),
  probe: vi.fn(),
  proof: vi.fn(),
}));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => mocks.auth }));
vi.mock('@/api/remoteControl', () => ({
  getRemoteDeviceChallenge: mocks.challenge,
  registerRemoteDevice: mocks.register,
}));
vi.mock('@/services/remoteDeviceNative', async (original) => ({
  ...(await original<typeof import('@/services/remoteDeviceNative')>()),
  probeRemoteDeviceSupport: mocks.probe,
  createRemoteDeviceProof: mocks.proof,
}));
import { useRemoteDevicesStore } from '@/stores/remoteDevices';
import { clearRemoteControlLocally } from '@/services/remoteControlSafety';
const sid = '22222222-2222-4222-8222-222222222222';
const token = (userId = 1, value = sid) =>
  `header.${btoa(JSON.stringify({ userId, sid: value }))}.signature`;
const device = {
  deviceId: '11111111-1111-4111-8111-111111111111',
  alias: '办公电脑',
  platform: 'macos' as const,
  revokedAt: null,
  createdAt: new Date().toISOString(),
};
function deferred<T = any>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  clearRemoteControlLocally('TEST_RESET');
  setActivePinia(createPinia());
  vi.clearAllMocks();
  Object.assign(mocks.auth, {
    token: token(),
    currentUser: { id: 1 },
    authGeneration: 1,
    loggingOut: false,
  });
  mocks.probe.mockResolvedValue({
    desktop: true,
    registration: true,
    identityReset: true,
    consent: false,
    platform: 'macos',
  });
  mocks.challenge.mockImplementation(async () => ({
    challenge: {
      id: device.deviceId,
      nonce: 'A'.repeat(43),
      userId: 1,
      sid,
      action: 'register-device',
      expiresAt: Date.now() + 29000,
    },
  }));
  mocks.proof.mockResolvedValue({
    challengeId: device.deviceId,
    alias: device.alias,
    platform: 'macos',
    publicKey: 'public',
    signature: 'signature',
  });
  mocks.register.mockResolvedValue({ device });
});
describe('本机远控自动初始化', () => {
  it('登记按挑战→原生限定proof→POST，不捏造在线/可控状态', async () => {
    const store = useRemoteDevicesStore();
    expect(await store.ensureLocalDevice()).toBe(device.deviceId);
    expect(mocks.register).toHaveBeenCalledWith(
      await mocks.proof.mock.results[0]!.value,
      expect.any(AbortSignal),
    );
    expect(store.localDeviceId).toBe(device.deviceId);
  });
  it('Web不能创建登记挑战或原生签名', async () => {
    mocks.probe.mockResolvedValue({ desktop: false, registration: false });
    const store = useRemoteDevicesStore();
    expect(store.localDeviceId).toBeNull();
    expect(await store.ensureLocalDevice()).toBeNull();
    expect(mocks.challenge).not.toHaveBeenCalled();
  });
  it('取消后迟到challenge不能触发本机密钥操作', async () => {
    const wait = deferred();
    mocks.challenge.mockReturnValue(wait.promise);
    const store = useRemoteDevicesStore();
    const pending = store.ensureLocalDevice();
    await flushPromises();
    store.cancel();
    wait.resolve({ challenge: {} });
    expect(await pending).toBeNull();
    expect(mocks.proof).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
  });
  it('取消等待本机签名立即abort，迟到proof不能POST', async () => {
    const wait = deferred();
    mocks.proof.mockReturnValue(wait.promise);
    const store = useRemoteDevicesStore();
    const pending = store.ensureLocalDevice();
    await flushPromises();
    const signal = mocks.proof.mock.calls[0]![2];
    store.cancel();
    expect(signal.aborted).toBe(true);
    wait.resolve({});
    expect(await pending).toBeNull();
    expect(mocks.register).not.toHaveBeenCalled();
  });
  it('注销或账号切换后旧proof不得使用新账号token提交', async () => {
    const wait = deferred();
    mocks.proof.mockReturnValue(wait.promise);
    const store = useRemoteDevicesStore();
    const pending = store.ensureLocalDevice();
    await flushPromises();
    mocks.auth.authGeneration++;
    mocks.auth.token = token(2);
    mocks.auth.currentUser = { id: 2 };
    clearRemoteControlLocally('AUTH_REPLACED');
    wait.resolve({});
    expect(await pending).toBeNull();
    expect(mocks.register).not.toHaveBeenCalled();
    expect(store.localDeviceId).toBeNull();
  });
  it('即使遗漏cleanup，authGeneration/sid变化仍阻止提交', async () => {
    const wait = deferred();
    mocks.proof.mockReturnValue(wait.promise);
    const store = useRemoteDevicesStore();
    const pending = store.ensureLocalDevice();
    await flushPromises();
    mocks.auth.token = token(1, '33333333-3333-4333-8333-333333333333');
    wait.resolve({});
    expect(await pending).toBeNull();
    expect(mocks.register).not.toHaveBeenCalled();
  });
  it('POST之后取消不会声称回滚，旧成功不能污染新账号设备', async () => {
    const wait = deferred();
    mocks.register.mockReturnValue(wait.promise);
    const store = useRemoteDevicesStore();
    const pending = store.ensureLocalDevice();
    await flushPromises();
    store.cancel();
    expect(mocks.register.mock.calls[0]![1].aborted).toBe(true);
    mocks.auth.authGeneration++;
    mocks.auth.token = token(2);
    mocks.auth.currentUser = { id: 2 };
    clearRemoteControlLocally('AUTH_REPLACED');
    wait.resolve({ device });
    expect(await pending).toBeNull();
    expect(store.localDeviceId).toBeNull();
  });
  it('挑战身份不匹配时不调用native；网络失败不自动重放登记', async () => {
    const store = useRemoteDevicesStore();
    mocks.challenge.mockResolvedValue({ challenge: { userId: 2 } });
    expect(await store.ensureLocalDevice()).toBeNull();
    expect(mocks.proof).not.toHaveBeenCalled();
    mocks.challenge.mockRejectedValue(new Error('offline'));
    expect(await store.ensureLocalDevice()).toBeNull();
    expect(mocks.challenge).toHaveBeenCalledTimes(2);
    expect(mocks.register).not.toHaveBeenCalled();
  });
});

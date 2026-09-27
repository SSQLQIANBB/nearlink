import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';
const mocks = vi.hoisted(() => ({
  capabilities: { canControl: true, targets: [{ deviceId: 'device', alias: 'Test device', platform: 'macos', online: true, busy: false, canHostView: true, canHostControl: true }], capabilities: { runtime: 'web' } },
  ice: vi.fn(), keys: vi.fn(), peers: [] as any[], adapters: [] as any[],
}));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ token: 'authenticated-token', loggingOut: false }) }));
vi.mock('@/stores/remoteControl', () => ({ useRemoteControlStore: () => mocks.capabilities }));
vi.mock('@/api/remoteControl', () => ({ getRemoteSessionIce: mocks.ice, getRemoteSigningKeys: mocks.keys }));
vi.mock('@/services/remoteControlAdapter', () => ({ SocketRemoteControllerAdapter: class {
  request = vi.fn().mockResolvedValue('session'); signal = vi.fn().mockResolvedValue(undefined); ready = vi.fn().mockResolvedValue(undefined);
  end = vi.fn().mockResolvedValue(undefined); dispose = vi.fn(); requestControl = vi.fn().mockResolvedValue(undefined);
  constructor(_token: string, _platform: string, public event: (value: any) => void) { mocks.adapters.push(this); }
} }));
vi.mock('@/services/remoteControlPeer', () => ({ sdpSha256Fingerprint: vi.fn(), RemoteControlPeer: class {
  start = vi.fn().mockResolvedValue(undefined); end = vi.fn(); attachVideo = vi.fn(); pauseInput = vi.fn();
  sendInput = vi.fn().mockReturnValue(true); requestInputArm = vi.fn().mockReturnValue(true); observeAuthorization = vi.fn();
  mapPointer = vi.fn().mockReturnValue({ x: 0.25, y: 0.75 });
  receiveSignal = vi.fn().mockResolvedValue(true); installConnectionProof = vi.fn().mockResolvedValue(true); installMediaLease = vi.fn().mockResolvedValue(true);
  constructor(public options: any) { mocks.peers.push(this); }
} }));
import { mediaOccupancy } from '@/services/mediaOccupancy';
import { useRemoteControlSessionStore } from '@/stores/remoteControlSession';
const bootstrap = { sessionId: 'session', host: {}, controller: {}, consentNonce: 'nonce', screenId: 'screen', negotiationId: 'negotiation', hardDeadline: Date.now() + 60000 };
beforeEach(() => {
  mediaOccupancy.stop('TEST_RESET');
  setActivePinia(createPinia()); vi.clearAllMocks();
  mocks.capabilities.canControl = true; mocks.peers = []; mocks.adapters = [];
  mocks.ice.mockResolvedValue({ iceServers: [{ urls: ['turn:turn.example.com:3478?transport=udp'], username: 'temporary', credential: 'test-only' }], iceTransportPolicy: 'all', expiresAt: bootstrap.hardDeadline + 299000 });
  mocks.keys.mockResolvedValue({ keys: [] });
});
async function connected() {
  const store = useRemoteControlSessionStore();
  await store.start(mocks.capabilities.targets[0]!, 'control');
  mocks.adapters[0].event({ type: 'connecting', value: bootstrap });
  await flushPromises();
  return store;
}
describe('远控主控会话接线', () => {
  it('仅观看不会在焦点变化后显示恢复键鼠操作提示', async () => {
    const store = await connected();
    const peer = mocks.peers[0];
    peer.options.onAuthorization('view');
    peer.options.onPauseInput('REMOTE_VIEW_ONLY');
    expect(store.statusMessage).toBe('仅观看，尚未授予键鼠控制权限');
    peer.options.onAuthorization('control');
    peer.options.onPauseInput('REMOTE_HOST_PAUSED');
    expect(store.statusMessage).toContain('操作已暂停');
  });
  it('连接失败保留错误代码并释放资源，不展示任意异常正文', async () => {
    const store = useRemoteControlSessionStore();
    mocks.ice.mockRejectedValueOnce(new Error('REMOTE_ICE_CONFIGURATION'));
    await store.start(mocks.capabilities.targets[0]!, 'view');
    mocks.adapters[0].event({ type: 'connecting', value: bootstrap });
    await flushPromises();
    expect(store.phase).toBe('ended');
    expect(store.failureCode).toBe('REMOTE_ICE_CONFIGURATION');
    expect(mediaOccupancy.current.value).toBeNull();
    mocks.ice.mockRejectedValueOnce(new Error('credential=private-value'));
    await store.start(mocks.capabilities.targets[0]!, 'view');
    expect(store.failureCode).toBe('');
    mocks.adapters[1].event({ type: 'connecting', value: bootstrap });
    await flushPromises();
    expect(store.failureCode).toBe('REMOTE_PROTOCOL_FAILED');
  });
  it('界面坐标仅交给peer已验证的布局映射', async () => {
    const store = await connected();
    expect(store.mapPointer(120, 240)).toEqual({ x: 0.25, y: 0.75 });
    expect(mocks.peers[0].mapPointer).toHaveBeenCalledWith(120, 240);
    store.end(); expect(store.mapPointer(120, 240)).toBeNull();
  });
  it('未发布不创建socket；已有群组媒体时拒绝远控且不抢占', async () => {
    const store = useRemoteControlSessionStore();
    mocks.capabilities.canControl = false;
    await expect(store.start(mocks.capabilities.targets[0]!, 'control')).rejects.toThrow();
    expect(mocks.adapters).toHaveLength(0);
    mocks.capabilities.canControl = true;
    const group = mediaOccupancy.acquire('group-call', 'group')!;
    await expect(store.start(mocks.capabilities.targets[0]!, 'control')).rejects.toThrow('请先结束');
    expect(group.isCurrent()).toBe(true); group.release();
  });
  it('普通active(control)状态不能授权媒体；只有peer验证租约回调后激活', async () => {
    const store = await connected();
    mocks.adapters[0].event({ type: 'state', value: { sessionId: 'session', state: 'active', scope: 'control', authorizationRevision: 1, controlEpoch: 1 } });
    await flushPromises();
    expect(store.phase).toBe('connecting'); expect(store.stream).toBeNull(); expect(store.inputArmed).toBe(false);
    mocks.peers[0].options.onAuthorization('control');
    expect(store.phase).toBe('active'); expect(store.inputArmed).toBe(false);
    store.end();
  });
  it('结束后迟到ICE/公钥响应不能创建peer或恢复占用', async () => {
    let resolve!: (value: unknown) => void;
    mocks.ice.mockImplementation(() => new Promise(done => { resolve = done; }));
    const store = useRemoteControlSessionStore();
    await store.start(mocks.capabilities.targets[0]!, 'view');
    mocks.adapters[0].event({ type: 'connecting', value: bootstrap }); await flushPromises();
    store.end('LOGOUT');
    resolve({ iceServers: [{ urls: ['turn:turn.example.com:3478?transport=udp'], username: 'temporary', credential: 'test-only' }], iceTransportPolicy: 'all', expiresAt: bootstrap.hardDeadline + 299000 }); await flushPromises();
    expect(mocks.peers).toHaveLength(0); expect(mediaOccupancy.current.value).toBeNull(); expect(store.phase).toBe('ended');
  });
  it('旧会话迟到队列不能减少新会话的事件上限计数', async () => {
    let resolveOld!: (value: unknown) => void;
    let resolveNew!: (value: unknown) => void;
    mocks.ice.mockImplementationOnce(() => new Promise(done => { resolveOld = done; }))
      .mockImplementationOnce(() => new Promise(done => { resolveNew = done; }));
    const store = useRemoteControlSessionStore();
    const state = { type: 'state', value: { sessionId: 'session', state: 'active', scope: 'control', authorizationRevision: 1, controlEpoch: 1 } };
    await store.start(mocks.capabilities.targets[0]!, 'view');
    mocks.adapters[0].event({ type: 'connecting', value: bootstrap }); await flushPromises();
    for (let index = 0; index < 100; index++) mocks.adapters[0].event(state);
    store.end();
    await store.start(mocks.capabilities.targets[0]!, 'view');
    mocks.adapters[1].event({ type: 'connecting', value: bootstrap }); await flushPromises();
    const ice = { iceServers: [{ urls: ['turn:turn.example.com:3478?transport=udp'], username: 'temporary', credential: 'test-only' }], iceTransportPolicy: 'all', expiresAt: bootstrap.hardDeadline + 299000 };
    resolveOld(ice); await flushPromises();
    for (let index = 0; index < 140; index++) mocks.adapters[1].event(state);
    expect(store.phase).toBe('connecting');
    mocks.adapters[1].event(state);
    expect(store.phase).toBe('ended');
    expect(mocks.adapters[1].end).toHaveBeenCalledWith('REMOTE_EVENT_LIMIT');
    resolveNew(ice); await flushPromises();
    expect(mocks.peers).toHaveLength(0);
  });
  it('文字等待首张有效窗口，armed先到不会丢字，失焦取消不会晚发', async () => {
    const store = await connected();
    const peer = mocks.peers[0]; peer.options.onAuthorization('control');
    const pending = store.commitText('中文👋');
    peer.options.onInputArmed(true);
    expect(peer.sendInput).not.toHaveBeenCalled();
    peer.options.onInputWindow();
    expect(await pending).toBe(true);
    expect(peer.sendInput).toHaveBeenCalledWith(expect.objectContaining({ type: 'text', payload: expect.objectContaining({ text: '中文👋' }) }));
    store.pauseInput(); peer.sendInput.mockClear();
    const cancelled = store.commitText('不可晚发'); store.pauseInput(); peer.options.onInputWindow();
    expect(await cancelled).toBe(false); expect(peer.sendInput).not.toHaveBeenCalled();
    store.end();
  });
});

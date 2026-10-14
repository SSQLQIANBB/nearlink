import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
const mocks = vi.hoisted(() => ({
  channel: null as any,
  nativeClose: null as any,
  close: null as any,
  unlisten: vi.fn(),
  auth: { token: 'old', $patch: vi.fn() },
}));
vi.mock('@/services/desktopAuxiliaryContext', () => ({
  auxiliaryId: 'test-id',
  setAuxiliaryCloseHandler: (fn: Function) => {
    mocks.close = fn;
  },
}));
vi.mock('@/stores', () => ({ pinia: {} }));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => mocks.auth }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async (fn: Function) => {
      mocks.nativeClose = fn;
      return mocks.unlisten;
    },
  }),
}));
vi.mock('@/services/desktopWindowChannel', () => ({
  prepareDesktopWindowChannel: () => Promise.resolve(),
  DesktopWindowChannel: class {
    onmessage: any;
    postMessage = vi.fn();
    close = vi.fn();
    constructor() {
      mocks.channel = this;
    }
    receive(data: unknown) {
      this.onmessage({ data });
    }
  },
}));
let client: typeof import('@/services/desktopAuxiliaryClient');
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  client = await import('@/services/desktopAuxiliaryClient');
  const initial = client.initializeAuxiliaryClient();
  await flushPromises();
  mocks.channel.receive({
    type: 'bootstrap',
    bootstrap: {
      content: { kind: 'private', incoming: { from: 'peer', deviceType: 2 } },
      token: 'token',
      refreshToken: 'refresh',
      user: { id: 1 },
      socketId: 'main-id',
      connected: true,
      authenticated: true,
    },
  });
  await initial;
});
describe('独立窗口媒体客户端', () => {
  it('不建立网络 Socket；来电先于启动时缓存的挂断交给组件', async () => {
    const order: string[] = [];
    client.auxiliarySocket.on('webrtc_call_request', () => order.push('incoming'));
    client.auxiliarySocket.on('webrtc_hangup', () => order.push('hangup'));
    mocks.channel.receive({ type: 'signal', event: 'webrtc_hangup', args: [{ from: 'peer' }] });
    await client.mountAuxiliaryClient(vi.fn(), vi.fn());
    expect(order).toEqual(['incoming', 'hangup']);
    expect(client.auxiliarySocket.id).toBe('main-id');
    expect(client.auxiliarySocket.io.engine).toBeUndefined();
    expect(mocks.channel.postMessage).toHaveBeenCalledWith({ type: 'ready' });
  });
  it('原生关闭先卸载释放媒体，再发送 closed，重复关闭无副作用', async () => {
    const unmount = vi.fn(() =>
      client.auxiliarySocket.emit('webrtc_hangup', { to: { socketId: 'peer' } }),
    );
    await client.mountAuxiliaryClient(unmount, vi.fn());
    const preventDefault = vi.fn();
    mocks.nativeClose({ preventDefault });
    mocks.close();
    expect(unmount).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(
      mocks.channel.postMessage.mock.calls.slice(-2).map(([data]: any[]) => data.type),
    ).toEqual(['emit', 'closed']);
    expect(mocks.unlisten).toHaveBeenCalledOnce();
  });
  it('尚未挂载收到关闭时，不再启动通话', async () => {
    mocks.channel.receive({ type: 'close' });
    const unmount = vi.fn();
    const start = vi.fn();
    await client.mountAuxiliaryClient(unmount, start);
    expect(unmount).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
  });
  it('ICE 对象通过 toJSON 发送，不跨窗口传递媒体对象', () => {
    const candidate = { toJSON: () => ({ candidate: 'candidate-data', sdpMid: '0' }) };
    client.auxiliarySocket.emit('webrtc_ice', { candidate });
    expect(mocks.channel.postMessage).toHaveBeenCalledWith({
      type: 'emit',
      event: 'webrtc_ice',
      args: [{ candidate: { candidate: 'candidate-data', sdpMid: '0' } }],
    });
  });
  it('并发 401 共用主窗口刷新，收到凭证后才允许重试', async () => {
    const first = client.refreshAuxiliaryAuth();
    const second = client.refreshAuxiliaryAuth();
    expect(first).toBe(second);
    mocks.channel.receive({
      type: 'refreshed-auth',
      success: true,
      token: 'new',
      refreshToken: 'new-refresh',
    });
    expect(await first).toBe(true);
    expect(mocks.auth.$patch).toHaveBeenCalledWith({ token: 'new', refreshToken: 'new-refresh' });
  });
});

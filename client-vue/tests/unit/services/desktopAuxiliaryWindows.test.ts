import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive, markRaw } from 'vue';
import { flushPromises } from '@vue/test-utils';

const mocks = vi.hoisted(() => ({
  windows: [] as any[],
  channels: [] as any[],
  desktop: true,
  failCreate: false,
  auth: null as any,
  socketStore: null as any,
  calls: null as any,
}));
vi.mock('@/services/desktopAuxiliaryContext', () => ({
  get isDesktopWindow() {
    return mocks.desktop;
  },
  isAuxiliaryWindow: false,
}));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => mocks.auth }));
vi.mock('@/stores/socket', () => ({ useSocketStore: () => mocks.socketStore }));
vi.mock('@/stores/privateCall', () => ({ usePrivateCallStore: () => mocks.calls }));
vi.mock('@/services/desktopWindowChannel', () => ({
  prepareDesktopWindowChannel: () => Promise.resolve(),
  DesktopWindowChannel: class {
    onmessage: any;
    postMessage = vi.fn();
    close = vi.fn();
    constructor() {
      mocks.channels.push(this);
    }
    receive(data: unknown) {
      this.onmessage({ data });
    }
  },
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: class {
    handlers = new Map<string, Function>();
    destroy = vi.fn(async () => {
      this.handlers.get('tauri://destroyed')?.();
    });
    unminimize = vi.fn();
    setFocus = vi.fn();
    constructor(
      public label: string,
      public options: unknown,
    ) {
      mocks.windows.push(this);
    }
    async once(event: string, handler: Function) {
      this.handlers.set(event, handler);
      if (event === (mocks.failCreate ? 'tauri://error' : 'tauri://created'))
        queueMicrotask(() => handler({ payload: 'creation failed' }));
      return () => this.handlers.delete(event);
    }
  },
}));

let service: typeof import('@/services/desktopAuxiliaryWindows');
let occupancy: (typeof import('@/services/mediaOccupancy'))['mediaOccupancy'];
let dispose: (() => void) | undefined;
let events: Map<string, Function>;
let relay: Function;
beforeEach(async () => {
  vi.resetModules();
  mocks.windows = [];
  mocks.channels = [];
  mocks.desktop = true;
  mocks.failCreate = false;
  events = new Map();
  const socket = markRaw({
    id: 'main-socket',
    emit: vi.fn(),
    onAny: vi.fn((fn) => {
      relay = fn;
    }),
    offAny: vi.fn(),
    on: vi.fn((event, fn) => events.set(event, fn)),
    off: vi.fn(),
  });
  mocks.socketStore = reactive({
    socket,
    connected: true,
    authenticated: true,
    joinGroup: vi.fn(),
  });
  mocks.auth = reactive({
    token: 'test',
    refreshToken: 'refresh',
    currentUser: { id: 1 },
    authGeneration: 0,
    loggingOut: false,
  });
  mocks.calls = reactive({ request: null, busy: false });
  service = await import('@/services/desktopAuxiliaryWindows');
  occupancy = (await import('@/services/mediaOccupancy')).mediaOccupancy;
});
afterEach(async () => {
  for (const channel of mocks.channels) channel.receive({ type: 'closed' });
  await flushPromises();
  dispose?.();
  dispose = undefined;
  occupancy.stop('TEST');
});
const outgoing = {
  kind: 'private' as const,
  request: { user: { id: 2, socketId: 'peer' }, type: 0 as const },
};

describe('桌面独立窗口', () => {
  it.each([0, 2] as const)('来电邀请使用紧凑窗口（类型 %s）', async (deviceType) => {
    await service.openAuxiliaryWindow({ kind: 'private', incoming: { from: 'peer', deviceType } });
    expect(mocks.windows[0].options).toMatchObject({
      width: 440, height: 260, minWidth: 440, minHeight: 260,
    });
  });
  it('主动通话保留完整媒体窗口尺寸', async () => {
    await service.openAuxiliaryWindow(outgoing);
    expect(mocks.windows[0].options).toMatchObject({
      width: 1100, height: 760, minWidth: 640, minHeight: 480,
    });
  });
  it('连续点击等待同一个原生窗口创建完成再唤起', async () => {
    await Promise.all([
      service.openAuxiliaryWindow(outgoing),
      service.openAuxiliaryWindow(outgoing),
    ]);
    expect(mocks.windows).toHaveLength(1);
    expect(mocks.windows[0].setFocus).toHaveBeenCalledOnce();
  });
  it('信令未认证时不创建没有端点身份的通话窗口', async () => {
    mocks.socketStore.authenticated = false;
    await expect(service.openAuxiliaryWindow(outgoing)).rejects.toThrow('连接尚未就绪');
    expect(mocks.windows).toHaveLength(0);
    expect(occupancy.current.value).toBeNull();
  });
  it('刷新媒体窗口结束旧会话，避免重新发起通话', async () => {
    await service.openAuxiliaryWindow(outgoing);
    mocks.channels[0].receive({ type: 'ready' });
    mocks.channels[0].receive({ type: 'hello' });
    await flushPromises();
    expect(mocks.windows[0].destroy).toHaveBeenCalledOnce();
    expect(mocks.socketStore.socket.emit).toHaveBeenCalledWith('webrtc_hangup', {
      to: { socketId: 'peer' },
    });
    expect(occupancy.current.value).toBeNull();
  });
  it('网页群通话不创建原生窗口', async () => {
    mocks.desktop = false;
    expect(await service.openDesktopGroupWindow('/group-video/2')).toBe(false);
    expect(mocks.windows).toHaveLength(0);
  });
  it('图片预览复用窗口且不占用通话资源', async () => {
    await service.openAuxiliaryWindow({ kind: 'image', src: '/a.png', alt: 'A' });
    await service.openAuxiliaryWindow({ kind: 'image', src: '/b.png', alt: 'B' });
    expect(mocks.windows).toHaveLength(1);
    expect(mocks.windows[0].setFocus).toHaveBeenCalledOnce();
    expect(mocks.channels[0].postMessage).toHaveBeenCalledWith({
      type: 'image',
      content: { kind: 'image', src: '/b.png', alt: 'B' },
    });
    expect(occupancy.current.value).toBeNull();
  });
  it('复用主窗口 socketId，启动期间暂存信令并保持顺序', async () => {
    dispose = service.installDesktopAuxiliaryHost(vi.fn());
    await service.openAuxiliaryWindow(outgoing);
    const channel = mocks.channels[0];
    channel.receive({ type: 'hello' });
    expect(channel.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'bootstrap',
        bootstrap: expect.objectContaining({ socketId: 'main-socket', authenticated: true }),
      }),
    );
    relay('webrtc_answer', { from: 'peer' });
    relay('webrtc_ice', { from: 'peer' });
    expect(
      channel.postMessage.mock.calls.filter(([data]: any[]) => data.type === 'signal'),
    ).toHaveLength(0);
    channel.receive({ type: 'ready' });
    expect(
      channel.postMessage.mock.calls
        .filter(([data]: any[]) => data.type === 'signal')
        .map(([data]: any[]) => data.event),
    ).toEqual(['webrtc_answer', 'webrtc_ice']);
  });
  it('关闭完成后释放占用；同一通话重复打开只唤起窗口', async () => {
    await service.openAuxiliaryWindow(outgoing);
    await service.openAuxiliaryWindow(outgoing);
    expect(mocks.windows).toHaveLength(1);
    expect(occupancy.current.value?.kind).toBe('private-call');
    mocks.channels[0].receive({ type: 'closed' });
    await flushPromises();
    expect(mocks.windows[0].destroy).toHaveBeenCalledOnce();
    expect(occupancy.current.value).toBeNull();
    expect(mocks.calls.busy).toBe(false);
  });
  it('已有远控时拒绝打开通话，创建失败也释放占用', async () => {
    occupancy.acquire('remote-control', 'remote');
    await expect(service.openAuxiliaryWindow(outgoing)).rejects.toThrow('请先结束');
    occupancy.stop('TEST');
    mocks.failCreate = true;
    await expect(service.openAuxiliaryWindow(outgoing)).rejects.toThrow('creation failed');
    expect(occupancy.current.value).toBeNull();
    expect(mocks.calls.busy).toBe(false);
  });
  it('来电打开窗口，忙于群通话时回复拒绝', async () => {
    dispose = service.installDesktopAuxiliaryHost(vi.fn());
    events.get('webrtc_call_request')!({ from: 'peer', deviceType: 2 });
    await flushPromises();
    expect(mocks.windows).toHaveLength(1);
    mocks.channels[0].receive({ type: 'closed' });
    await flushPromises();
    await service.openDesktopGroupWindow('/group-video/7');
    events.get('webrtc_call_request')!({ from: 'other', deviceType: 0 });
    expect(mocks.socketStore.socket.emit).toHaveBeenCalledWith('webrtc_call_response', {
      to: { socketId: 'other' },
      accepted: false,
    });
  });
  it('退出登录请求子窗口清理，异常销毁补发挂断', async () => {
    dispose = service.installDesktopAuxiliaryHost(vi.fn());
    await service.openAuxiliaryWindow(outgoing);
    mocks.auth.loggingOut = true;
    expect(mocks.channels[0].postMessage).toHaveBeenCalledWith({ type: 'close' });
    mocks.windows[0].handlers.get('tauri://destroyed')();
    expect(mocks.socketStore.socket.emit).toHaveBeenCalledWith('webrtc_hangup', {
      to: { socketId: 'peer' },
    });
    expect(occupancy.current.value).toBeNull();
  });
  it('子窗口退出不取消主窗口的群消息订阅', async () => {
    await service.openDesktopGroupWindow('/group-screen/7');
    const channel = mocks.channels[0];
    channel.receive({ type: 'emit', event: 'join_group', args: [{ groupId: 7 }] });
    channel.receive({ type: 'emit', event: 'leave_group', args: [{ groupId: 7 }] });
    channel.receive({
      type: 'emit',
      event: 'leave_group_call',
      args: [{ groupId: 7, deviceType: 2 }],
    });
    expect(mocks.socketStore.joinGroup).toHaveBeenCalledWith(7);
    expect(mocks.socketStore.socket.emit).not.toHaveBeenCalledWith(
      'leave_group',
      expect.anything(),
    );
    expect(mocks.socketStore.socket.emit).toHaveBeenCalledWith('leave_group_call', {
      groupId: 7,
      deviceType: 2,
    });
  });
});

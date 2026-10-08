import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { installDesktopWindowControls } from '@/services/desktopWindow';

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(), isFullscreen: vi.fn(), startDragging: vi.fn(),
  isMaximized: vi.fn(), toggleMaximize: vi.fn(),
  onResized: vi.fn(), onFocusChanged: vi.fn(), unresize: vi.fn(), unfocus: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: mocks.isTauri }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => mocks }));
let cleanup: (() => void) | undefined;
const press = (selector: string, button = 0) => document.querySelector(selector)!.dispatchEvent(
  new MouseEvent('mousedown', { bubbles: true, cancelable: true, button, detail: 1 }),
);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  mocks.isTauri.mockReturnValue(true);
  mocks.isFullscreen.mockResolvedValue(false);
  mocks.startDragging.mockResolvedValue(undefined);
  mocks.isMaximized.mockResolvedValue(false);
  mocks.toggleMaximize.mockResolvedValue(undefined);
  mocks.onResized.mockResolvedValue(mocks.unresize);
  mocks.onFocusChanged.mockResolvedValue(mocks.unfocus);
  document.body.innerHTML = '<header class="chat-header"><span id="title">联系人</span><button><span id="action">操作</span></button><input /><a href="#">链接</a></header><main>聊天内容</main>';
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  document.documentElement.classList.remove('desktop-fullscreen');
});

describe('桌面标题与全屏状态', () => {
  it('标题文字和背景可拖动，按钮、输入框、链接及聊天内容不触发拖动', async () => {
    cleanup = installDesktopWindowControls();
    await flushPromises();
    press('#title');
    press('header');
    expect(mocks.startDragging).toHaveBeenCalledTimes(2);
    for (const selector of ['#action', 'input', 'a', 'main']) press(selector);
    press('#title', 2);
    expect(mocks.startDragging).toHaveBeenCalledTimes(2);
  });

  it('进入全屏取消预留区域，退出后恢复；全屏中不调用窗口拖动', async () => {
    cleanup = installDesktopWindowControls();
    await flushPromises();
    mocks.isFullscreen.mockResolvedValue(true);
    mocks.onResized.mock.calls[0]![0]();
    await flushPromises();
    expect(document.documentElement.classList.contains('desktop-fullscreen')).toBe(true);
    press('#title');
    expect(mocks.startDragging).not.toHaveBeenCalled();
    mocks.isFullscreen.mockResolvedValue(false);
    mocks.onFocusChanged.mock.calls[0]![0]();
    await flushPromises();
    expect(document.documentElement.classList.contains('desktop-fullscreen')).toBe(false);
    press('#title');
    expect(mocks.startDragging).toHaveBeenCalledOnce();
  });

  it('全屏动画结束后的状态会再次同步', async () => {
    vi.useFakeTimers();
    cleanup = installDesktopWindowControls();
    await vi.advanceTimersByTimeAsync(0);
    mocks.onResized.mock.calls[0]![0]();
    await vi.advanceTimersByTimeAsync(0);
    mocks.isFullscreen.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(350);
    expect(document.documentElement.classList.contains('desktop-fullscreen')).toBe(true);
  });

  it('卸载后清理事件并忽略迟到的全屏查询', async () => {
    let finish!: (value: boolean) => void;
    mocks.isFullscreen.mockReturnValue(new Promise<boolean>(resolve => { finish = resolve; }));
    cleanup = installDesktopWindowControls();
    cleanup();
    cleanup = undefined;
    finish(true);
    await flushPromises();
    expect(mocks.unresize).toHaveBeenCalledOnce();
    expect(mocks.unfocus).toHaveBeenCalledOnce();
    expect(document.documentElement.classList.contains('desktop-fullscreen')).toBe(false);
    press('#title');
    expect(mocks.startDragging).not.toHaveBeenCalled();
  });

  it('普通网页不调用原生接口', () => {
    mocks.isTauri.mockReturnValue(false);
    cleanup = installDesktopWindowControls();
    press('#title');
    expect(mocks.isFullscreen).not.toHaveBeenCalled();
    expect(mocks.startDragging).not.toHaveBeenCalled();
  });

  it('Windows 双击标题切换最大化，交互元素、全屏及卸载后不处理', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
    const changed = vi.fn();
    cleanup = installDesktopWindowControls(changed);
    await flushPromises();
    expect(changed).toHaveBeenLastCalledWith(false);
    const doubleClick = (selector: string) => document.querySelector(selector)!.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, detail: 2 }),
    );
    doubleClick('#title');
    doubleClick('#action');
    expect(mocks.toggleMaximize).toHaveBeenCalledOnce();
    mocks.isMaximized.mockResolvedValue(true);
    mocks.onResized.mock.calls[0]![0]();
    await flushPromises();
    expect(changed).toHaveBeenLastCalledWith(true);
    mocks.isFullscreen.mockResolvedValue(true);
    mocks.onResized.mock.calls[0]![0]();
    await flushPromises();
    doubleClick('#title');
    cleanup();
    cleanup = undefined;
    doubleClick('#title');
    expect(mocks.toggleMaximize).toHaveBeenCalledOnce();
  });

  it('macOS 不接管双击最大化，也不查询 Windows 按钮状态', async () => {
    cleanup = installDesktopWindowControls();
    await flushPromises();
    document.querySelector('#title')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, detail: 2 }));
    expect(mocks.toggleMaximize).not.toHaveBeenCalled();
    expect(mocks.isMaximized).not.toHaveBeenCalled();
  });
});

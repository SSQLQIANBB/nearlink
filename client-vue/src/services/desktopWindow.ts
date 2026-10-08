import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

const titleRegions = '.chat-header, .group-im-shell header, .desktop-call-header, .desktop-windows-drag-region';
const interactive = 'button, a, input, textarea, select, [role="button"], [role="switch"], [contenteditable]:not([contenteditable="false"]), [data-no-drag]';

/** 标题内容可拖动，窗口事件同步全屏留白和 Windows 最大化按钮。 */
export function installDesktopWindowControls(onMaximizedChanged?: (maximized: boolean) => void): () => void {
  if (!isTauri()) return () => {};
  const window = getCurrentWindow();
  const isWindows = /Win/.test(navigator.platform);
  const root = document.documentElement;
  const unlisteners: Array<() => void> = [];
  let disposed = false;
  let fullscreen = false;
  let revision = 0;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  async function refreshWindowState() {
    const current = ++revision;
    try {
      const [value, maximized] = await Promise.all([
        window.isFullscreen(),
        onMaximizedChanged ? window.isMaximized() : false,
      ]);
      if (disposed || current !== revision) return;
      fullscreen = value;
      root.classList.toggle('desktop-fullscreen', value);
      onMaximizedChanged?.(maximized);
    } catch (error) {
      if (!disposed) console.warn('无法读取窗口状态', error);
    }
  }

  function onWindowChange() {
    void refreshWindowState();
    clearTimeout(settleTimer);
    // macOS 全屏动画结束后再次读取，避免保留过渡期间的状态。
    settleTimer = setTimeout(() => void refreshWindowState(), 350);
  }

  function onMouseDown(event: MouseEvent) {
    if (fullscreen || event.defaultPrevented || event.button !== 0 || event.detail > 2 || (!isWindows && event.detail > 1)) return;
    const target = event.target;
    if (!(target instanceof Element) || !target.closest(titleRegions) || target.closest(interactive)) return;
    event.preventDefault();
    // 原生拖动可能接管 mouseup，和 Tauri 拖动区一样在第二次 mousedown 处理双击。
    if (event.detail === 2) {
      void window.toggleMaximize().catch(error => console.warn('无法切换窗口大小', error));
    } else {
      void window.startDragging().catch(error => console.warn('无法拖动窗口', error));
    }
  }

  function register(pending: Promise<() => void>) {
    void pending.then(unlisten => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    }).catch(error => {
      if (!disposed) console.warn('无法监听窗口状态', error);
    });
  }

  document.addEventListener('mousedown', onMouseDown);
  register(window.onResized(onWindowChange));
  register(window.onFocusChanged(onWindowChange));
  void refreshWindowState();

  return () => {
    disposed = true;
    ++revision;
    clearTimeout(settleTimer);
    document.removeEventListener('mousedown', onMouseDown);
    for (const unlisten of unlisteners) unlisten();
    root.classList.remove('desktop-fullscreen');
  };
}

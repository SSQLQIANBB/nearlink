import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

export function useRemoteFullscreen(target: Ref<HTMLElement | null>, visible: () => boolean) {
  const fullscreen = ref(false);
  const busy = ref(false);
  const error = ref('');
  const nativeWindow = isTauri() ? getCurrentWindow() : null;
  let previousNativeFullscreen = false;
  let browserElement: HTMLElement | null = null;
  let pending: Promise<void> | undefined;
  let disposed = false;
  let unlisten: (() => void) | undefined;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;

  function syncBrowserFullscreen() {
    fullscreen.value = !!browserElement && document.fullscreenElement === browserElement;
  }

  async function change(enter: boolean) {
    busy.value = true;
    error.value = '';
    try {
      if (nativeWindow) {
        if (enter) previousNativeFullscreen = await nativeWindow.isFullscreen();
        await nativeWindow.setFullscreen(enter || previousNativeFullscreen);
        fullscreen.value = enter;
      } else if (enter) {
        browserElement = target.value!;
        await browserElement.requestFullscreen();
        syncBrowserFullscreen();
      } else if (browserElement && document.fullscreenElement === browserElement) {
        await document.exitFullscreen();
        fullscreen.value = false;
        browserElement = null;
      }
    } catch {
      error.value = enter ? '无法进入全屏，请重试。' : '无法退出全屏，请重试。';
    } finally {
      busy.value = false;
    }
  }

  function toggle() {
    if (busy.value || disposed || !visible() || !target.value) return;
    pending = change(!fullscreen.value);
  }

  async function close() {
    // 结束会话或卸载可能发生在原生全屏切换期间，待切换完成后再恢复窗口。
    await pending;
    if (fullscreen.value && !busy.value) {
      pending = change(false);
      await pending;
    }
  }

  function escape(event: KeyboardEvent) {
    if (!fullscreen.value || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    void close();
  }

  watch(visible, (value) => { if (!value) void close(); });
  onMounted(() => {
    if (!nativeWindow) document.addEventListener('fullscreenchange', syncBrowserFullscreen);
    window.addEventListener('keydown', escape, true);
    if (nativeWindow) {
      void nativeWindow.onResized(() => {
        clearTimeout(resizeTimer);
        // 等 macOS 全屏动画结束后读取，避免把过渡状态误认为已退出。
        resizeTimer = setTimeout(async () => {
          if (!fullscreen.value || busy.value || disposed) return;
          try {
            const active = await nativeWindow.isFullscreen();
            if (!disposed && !busy.value && !active) fullscreen.value = false;
          } catch {
            // 窗口关闭期间可能无法读取状态，退出由卸载清理负责。
          }
        }, 350);
      }).then((off) => {
        if (disposed) off();
        else unlisten = off;
      }).catch(() => { error.value = '无法监听窗口状态，可使用按钮退出全屏。'; });
    }
  });
  onBeforeUnmount(() => {
    disposed = true;
    document.removeEventListener('fullscreenchange', syncBrowserFullscreen);
    window.removeEventListener('keydown', escape, true);
    clearTimeout(resizeTimer);
    unlisten?.();
    void close();
  });
  return { fullscreen, fullscreenBusy: busy, fullscreenError: error, toggleFullscreen: toggle };
}

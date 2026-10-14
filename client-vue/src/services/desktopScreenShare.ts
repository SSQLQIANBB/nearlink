import { shallowRef } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface DesktopShareSource {
  id: string;
  name: string;
  app: string;
  kind: 'display' | 'window';
}
type Selection = { id: string; smooth: boolean };
export const screenPicker = shallowRef<{
  select: (selection: Selection) => void;
  cancel: () => void;
} | null>(null);
export const desktopShareError = shallowRef('');
export const desktopShareStarting = shallowRef(false);
let disposeCapture: (() => void) | undefined;

export function cancelDesktopScreenShare() {
  screenPicker.value?.cancel();
  disposeCapture?.();
}

/** Native frames become a normal video track; existing WebRTC and stop paths stay shared. */
export async function captureDesktopScreen(): Promise<MediaStream> {
  if (disposeCapture) throw new Error('已有共享正在启动或进行');
  desktopShareError.value = '';
  let stopped = false;
  let token: number | undefined;
  let unlisten: (() => void) | undefined;
  let videoTrack: MediaStreamTrack | undefined;
  let stopTrack: (() => void) | undefined;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d')!;
  const dispose = () => {
    if (stopped) return;
    stopped = true;
    unlisten?.();
    stopTrack?.();
    canvas.width = canvas.height = 0;
    desktopShareStarting.value = false;
    if (token !== undefined)
      void invoke('screen_share_stop', { token }).catch((error) =>
        console.error('停止原生共享失败', error),
      );
    if (disposeCapture === dispose) disposeCapture = undefined;
  };
  disposeCapture = dispose;
  const assertActive = () => {
    if (stopped) throw new DOMException('共享已取消', 'AbortError');
  };
  const ended = (error?: unknown) => {
    if (stopped) return;
    if (error) desktopShareError.value = `屏幕共享已停止：${String(error)}`;
    dispose();
    // stop() does not fire ended; native stop/source removal must notify the call owner.
    videoTrack?.dispatchEvent(new Event('ended'));
  };
  try {
    const selection = await new Promise<Selection>((resolve, reject) => {
      screenPicker.value = {
        select(value) {
          screenPicker.value = null;
          resolve(value);
        },
        cancel() {
          screenPicker.value = null;
          reject(new DOMException('已取消共享', 'AbortError'));
        },
      };
    });
    assertActive();
    desktopShareStarting.value = true;
    token = await invoke<number>('screen_share_start', { id: selection.id });
    if (stopped) {
      await invoke('screen_share_stop', { token });
      assertActive();
    }
    const detach = await listen<number>('desktop-share-stop', ({ payload }) => {
      if (payload === token) ended();
    });
    if (stopped) {
      detach();
      assertActive();
    }
    unlisten = detach;
    const drawFrame = async () => {
      const bytes = await invoke<ArrayBuffer>('screen_share_frame', {
        token,
        smooth: selection.smooth,
      });
      assertActive();
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      try {
        assertActive();
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        context.drawImage(bitmap, 0, 0);
        (videoTrack as CanvasCaptureMediaStreamTrack | undefined)?.requestFrame();
      } finally {
        bitmap.close();
      }
    };
    await drawFrame();
    assertActive();
    // The call WebView is hidden while sharing. Native pacing and explicit frames avoid
    // background setTimeout / automatic canvas capture throttling.
    const stream = canvas.captureStream(0);
    videoTrack = stream.getVideoTracks()[0]!;
    stopTrack = videoTrack.stop.bind(videoTrack);
    videoTrack.stop = dispose;
    (videoTrack as CanvasCaptureMediaStreamTrack).requestFrame();
    await invoke('screen_share_present', { token });
    assertActive();
    desktopShareStarting.value = false;
    const pump = async () => {
      try {
        while (!stopped) await drawFrame();
      } catch (error) {
        if (!stopped) ended(error);
      }
    };
    void pump();
    return stream;
  } catch (error) {
    dispose();
    throw error;
  }
}

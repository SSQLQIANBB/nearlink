import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
const native = vi.hoisted(() => ({ invoke: vi.fn(), handler: null as any, detach: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event, handler) => {
    native.handler = handler;
    return native.detach;
  }),
}));
import {
  captureDesktopScreen,
  cancelDesktopScreenShare,
  screenPicker,
  desktopShareError,
} from '@/services/desktopScreenShare';
let track: EventTarget & { stop: () => void };
let nativeTrackStop: () => void;
let rejectFrame: (reason: Error) => void;
const draw = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  native.invoke.mockReset();
  native.detach.mockClear();
  native.handler = null;
  nativeTrackStop = vi.fn();
  track = Object.assign(new EventTarget(), { stop: nativeTrackStop, requestFrame: vi.fn() });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw } as any);
  Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', {
    configurable: true,
    value: () => ({ getVideoTracks: () => [track] }),
  });
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 640, height: 400, close: vi.fn() })),
  );
  let frameCount = 0;
  native.invoke.mockImplementation(async (command) => {
    if (command === 'screen_share_start') return 11;
    if (command === 'screen_share_frame') {
      if (!frameCount++) return new ArrayBuffer(1);
      return new Promise((_resolve, reject) => {
        rejectFrame = reject;
      });
    }
  });
});
afterEach(() => {
  cancelDesktopScreenShare();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function start() {
  const pending = captureDesktopScreen();
  screenPicker.value!.select({ id: 'display:1', smooth: false });
  return pending;
}
describe('desktop screen capture lifecycle', () => {
  it('does not capture until a source is selected; cancel opens no native capture', async () => {
    const pending = captureDesktopScreen();
    expect(native.invoke).not.toHaveBeenCalled();
    screenPicker.value!.cancel();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(native.invoke).not.toHaveBeenCalled();
  });
  it('normal track.stop releases native capture, listener and future frames exactly once', async () => {
    await start();
    const ended = vi.fn();
    track.addEventListener('ended', ended);
    track.stop();
    track.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(nativeTrackStop).toHaveBeenCalledTimes(1);
    expect(native.detach).toHaveBeenCalledTimes(1);
    expect(native.invoke.mock.calls.filter(([c]) => c === 'screen_share_stop')).toHaveLength(1);
    expect(native.invoke.mock.calls.filter(([c]) => c === 'screen_share_frame')).toHaveLength(2);
    expect(ended).not.toHaveBeenCalled();
  });
  it('toolbar stop notifies the existing call owner, but stale tokens do not', async () => {
    await start();
    const ended = vi.fn();
    track.addEventListener('ended', ended);
    native.handler({ payload: 10 });
    expect(nativeTrackStop).not.toHaveBeenCalled();
    native.handler({ payload: 11 });
    expect(ended).toHaveBeenCalledTimes(1);
    expect(nativeTrackStop).toHaveBeenCalledTimes(1);
  });
  it('a native start that resolves after the window closes is stopped without presenting', async () => {
    let complete!: (token: number) => void;
    native.invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const pending = captureDesktopScreen();
    screenPicker.value!.select({ id: 'display:1', smooth: true });
    await flushPromises();
    cancelDesktopScreenShare();
    native.invoke.mockResolvedValue(undefined);
    complete(11);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(native.invoke).toHaveBeenCalledWith('screen_share_stop', { token: 11 });
    expect(native.invoke).not.toHaveBeenCalledWith('screen_share_present', expect.anything());
  });
  it('source removal ends the track and reports the capture failure', async () => {
    await start();
    const ended = vi.fn();
    track.addEventListener('ended', ended);
    rejectFrame(new Error('窗口已关闭'));
    await flushPromises();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(desktopShareError.value).toContain('窗口已关闭');
    expect(nativeTrackStop).toHaveBeenCalledTimes(1);
  });
});

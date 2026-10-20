import { getCurrentWindow } from '@tauri-apps/api/window';
import { ref, shallowRef } from 'vue';
import { DesktopWindowChannel, prepareDesktopWindowChannel } from './desktopWindowChannel';
import type { DialogKind } from './desktopDialogWindows';

export const dialogContent = shallowRef<{ kind: DialogKind; title: string; data: any }>();
export const dialogBusy = ref(false);
let channel: DesktopWindowChannel;
let sequence = 0;
let pending:
  | { id: number; resolve: (value: any) => void; reject: (error: Error) => void }
  | undefined;
export function dialogAction<T = any>(name: string, value?: unknown): Promise<T> {
  if (pending) return Promise.reject(new Error('请等待当前操作完成'));
  // Preview reads must not prevent cancelling or selecting a screen.
  const preview = name === 'screen_share_sources' || name === 'screen_share_preview';
  if (!preview) dialogBusy.value = true;
  return new Promise<T>((resolve, reject) => {
    pending = { id: ++sequence, resolve, reject };
    channel.postMessage({ type: 'action', request: sequence, name, value });
  }).finally(() => {
    if (!preview) dialogBusy.value = false;
  });
}
export function finishDialog(value?: unknown) {
  if (!dialogBusy.value) channel.postMessage({ type: 'finish', value });
}
export async function initializeDialogClient() {
  const params = new URLSearchParams(location.search);
  await prepareDesktopWindowChannel();
  channel = new DesktopWindowChannel(params.get('dialog')!, params.get('owner')!);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('无法连接所属窗口，请关闭后重试')), 15000);
    channel.onmessage = ({ data }) => {
      if (data.type === 'dialog') {
        clearTimeout(timer);
        dialogContent.value = data;
        resolve();
      } else if (data.type === 'reply' && pending && pending.id === data.request) {
        const request = pending;
        pending = undefined;
        if (data.error) request.reject(new Error(data.error));
        else request.resolve(data.value);
      }
    };
    channel.postMessage({ type: 'hello' });
  });
  const remove = await getCurrentWindow().onCloseRequested((event) => {
    event.preventDefault();
    finishDialog();
  });
  window.addEventListener(
    'beforeunload',
    () => {
      remove();
      pending?.reject(new Error('窗口已关闭'));
      channel.close();
    },
    { once: true },
  );
}

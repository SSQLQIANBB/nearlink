import { getCurrentScope, onScopeDispose } from 'vue';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { DesktopWindowChannel, prepareDesktopWindowChannel } from './desktopWindowChannel';
import { isDesktopWindow } from './desktopAuxiliaryContext';

export type DialogKind =
  | 'release'
  | 'confirm'
  | 'group-create'
  | 'group-edit'
  | 'group-detail'
  | 'group-invite'
  | 'password'
  | 'avatar'
  | 'forward'
  | 'recording'
  | 'annotation'
  | 'screen-picker';
export const isDialogWindow = isDesktopWindow && new URLSearchParams(location.search).has('dialog');
export type DialogActions = Record<string, (value: any) => unknown | Promise<unknown>>;
export interface DialogOptions {
  kind: DialogKind;
  title: string;
  key?: string;
  width?: number;
  height?: number;
  data?: unknown;
  actions?: DialogActions;
}
export interface DialogHandle {
  result: Promise<unknown>;
  close: () => Promise<void>;
}
const sessions = new Map<string, { handle: DialogHandle; focus: () => Promise<void> }>();

/** Requests stay in the owning window; credentials and sockets never enter dialog windows. */
export async function openDialogWindow(options: DialogOptions): Promise<DialogHandle> {
  await prepareDesktopWindowChannel();
  const owner = getCurrentWindow().label;
  const label = `dialog-${owner}-${options.key || options.kind}`;
  const previous = sessions.get(label);
  if (previous) {
    await previous.focus();
    return previous.handle;
  }
  const id = crypto.randomUUID();
  const channel = new DesktopWindowChannel(id, label);
  let finish!: (value: unknown) => void;
  let disposed = false;
  let ready = false;
  let busy = false;
  let closeValue: unknown;
  let closing: Promise<void> | undefined;
  const unlisteners: Array<() => void> = [];
  function track(pending: Promise<() => void>) {
    return pending.then((remove) => {
      if (disposed) remove();
      else unlisteners.push(remove);
    });
  }
  let startupTimer: ReturnType<typeof setTimeout>;
  const child = new WebviewWindow(label, {
    url: `index.html?dialog=${id}&owner=${encodeURIComponent(owner)}`,
    title: `${options.title} · NearLink`,
    width: options.width || 540,
    height: options.height || 620,
    minWidth: 360,
    minHeight: 280,
    center: true,
    visible: false,
    decorations: true,
    dragDropEnabled: false,
    parent: owner,
  });
  const created = new Promise<void>((resolve, reject) => {
    void track(child.once('tauri://created', () => resolve())).catch(reject);
    void track(child.once('tauri://error', (e) => reject(new Error(String(e.payload))))).catch(
      reject,
    );
  });
  function dispose(value?: unknown) {
    if (disposed) return;
    disposed = true;
    clearTimeout(startupTimer);
    for (const remove of unlisteners) remove();
    channel.close();
    sessions.delete(label);
    finish(value);
  }
  const close = async (value?: unknown) => {
    if (disposed) return;
    if (closing) return closing;
    closeValue = value;
    closing = (async () => {
      await created;
      await child.destroy();
      dispose(value);
    })();
    return closing;
  };
  const handle: DialogHandle = {
    result: new Promise((resolve) => {
      finish = resolve;
    }),
    close,
  };
  sessions.set(label, {
    handle,
    focus: async () => {
      await created;
      if (!disposed) {
        await child.unminimize();
        await child.setFocus();
      }
    },
  });
  channel.onmessage = ({ data }) => {
    if (disposed) return;
    if (data.type === 'hello') {
      // A refresh discards an in-progress form; never silently replay its mutations.
      if (ready) {
        void close();
        return;
      }
      ready = true;
      clearTimeout(startupTimer);
      channel.postMessage({
        type: 'dialog',
        kind: options.kind,
        title: options.title,
        data: options.data,
      });
      void created.then(() => child.show()).catch(() => {});
    } else if (data.type === 'finish' && !busy) {
      void close(data.value);
    } else if (data.type === 'action' && typeof data.name === 'string') {
      const action = options.actions?.[data.name];
      if (busy || !action || !Object.prototype.hasOwnProperty.call(options.actions, data.name)) {
        channel.postMessage({ type: 'reply', request: data.request, error: '操作不可用，请重试' });
        return;
      }
      const preview = data.name === 'screen_share_sources' || data.name === 'screen_share_preview';
      if (!preview) busy = true;
      void Promise.resolve()
        .then(() => action(data.value))
        .then(
          (value) => {
            if (!disposed) channel.postMessage({ type: 'reply', request: data.request, value });
          },
          (error) => {
            if (!disposed)
              channel.postMessage({
                type: 'reply',
                request: data.request,
                error: error instanceof Error ? error.message : '操作失败，请重试',
              });
          },
        )
        .finally(() => {
          if (!preview) busy = false;
        });
    }
  };
  startupTimer = setTimeout(() => {
    void close().catch(() => dispose());
  }, 20000);
  try {
    await created;
    await track(child.once('tauri://destroyed', () => dispose(closeValue)));
    return handle;
  } catch (error) {
    dispose();
    throw error;
  }
}

export function closeDesktopDialogs() {
  return Promise.all([...sessions.values()].map(({ handle }) => handle.close()));
}
export function closeDesktopDialog(key: string) {
  return sessions.get(`dialog-${getCurrentWindow().label}-${key}`)?.handle.close();
}
export function focusDesktopDialog(key: string) {
  return sessions.get(`dialog-${getCurrentWindow().label}-${key}`)?.focus();
}

/** Scope ownership also closes drafts when their page/conversation goes away. */
export function useDesktopDialogs() {
  const owned = new Set<DialogHandle>();
  let disposed = false;
  if (getCurrentScope())
    onScopeDispose(() => {
      disposed = true;
      for (const handle of owned) void handle.close();
    });
  return async (options: DialogOptions) => {
    const handle = await openDialogWindow(options);
    if (disposed) {
      await handle.close();
      return undefined;
    }
    owned.add(handle);
    try {
      return await handle.result;
    } finally {
      owned.delete(handle);
    }
  };
}

if (isDesktopWindow && !isDialogWindow) {
  window.addEventListener('beforeunload', () => {
    void closeDesktopDialogs();
  });
}

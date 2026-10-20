import { onScopeDispose } from 'vue';
import { useDialog, useMessage, type DialogOptions } from 'naive-ui';
import { isDesktopWindow } from './desktopAuxiliaryContext';
import { openDialogWindow, type DialogHandle } from './desktopDialogWindows';

/** Informational/decision dialogs only. Destructive confirmations keep useDialog. */
export function useWindowDialog() {
  const inline = useDialog();
  if (!isDesktopWindow) return inline;
  const message = useMessage();
  const active = new Set<{ destroy: () => void }>();
  onScopeDispose(() => {
    for (const item of active) item.destroy();
  });
  function open(options: DialogOptions) {
    let handle: DialogHandle | undefined;
    let destroyed = false;
    const item = {
      destroy: () => {
        destroyed = true;
        void handle?.close();
        active.delete(item);
      },
    };
    active.add(item);
    void openDialogWindow({
      kind: 'confirm',
      key: `confirm-${crypto.randomUUID()}`,
      title: String(options.title || '提示'),
      width: 440,
      height: 300,
      data: {
        content: options.content,
        positiveText: options.positiveText,
        negativeText: options.negativeText,
      },
      actions: {
        positive: () => options.onPositiveClick?.(new MouseEvent('click')),
        negative: () => options.onNegativeClick?.(new MouseEvent('click')),
      },
    })
      .then(async (result) => {
        handle = result;
        if (destroyed) {
          await handle.close();
          return;
        }
        const value = await handle.result;
        active.delete(item);
        if (!destroyed && value === undefined) options.onClose?.();
      })
      .catch((error) => {
        active.delete(item);
        message.error(String(error));
      });
    return item;
  }
  return {
    info: (options: DialogOptions) => open(options),
    warning: (options: DialogOptions) => open(options),
  };
}

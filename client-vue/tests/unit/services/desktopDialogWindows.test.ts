import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { flushPromises } from '@vue/test-utils';

const mocks = vi.hoisted(() => ({ windows: [] as any[], channels: [] as any[], owner: 'main' }));
vi.mock('@/services/desktopAuxiliaryContext', () => ({ isDesktopWindow: true }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: mocks.owner }) }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: class {
    events = new Map<string, Function>();
    show = vi.fn().mockResolvedValue(undefined);
    unminimize = vi.fn().mockResolvedValue(undefined);
    setFocus = vi.fn().mockResolvedValue(undefined);
    destroy = vi.fn(async () => {
      this.events.get('tauri://destroyed')?.();
    });
    constructor(
      public label: string,
      public options: unknown,
    ) {
      mocks.windows.push(this);
    }
    once(event: string, callback: Function) {
      this.events.set(event, callback);
      if (event === 'tauri://created') queueMicrotask(() => callback());
      return Promise.resolve(() => this.events.delete(event));
    }
  },
}));
vi.mock('@/services/desktopWindowChannel', () => ({
  prepareDesktopWindowChannel: vi.fn().mockResolvedValue(undefined),
  DesktopWindowChannel: class {
    onmessage: any;
    postMessage = vi.fn();
    close = vi.fn();
    constructor() {
      mocks.channels.push(this);
    }
  },
}));
import {
  openDialogWindow,
  closeDesktopDialogs,
  useDesktopDialogs,
} from '@/services/desktopDialogWindows';
beforeEach(() => {
  mocks.windows.length = 0;
  mocks.channels.length = 0;
  mocks.owner = 'main';
});
afterEach(async () => {
  await closeDesktopDialogs();
});

it('repeated opening focuses one owned window and close returns its result', async () => {
  const first = await openDialogWindow({ kind: 'annotation', title: '输入文字' });
  const second = await openDialogWindow({ kind: 'annotation', title: '输入文字' });
  expect(first).toBe(second);
  expect(mocks.windows).toHaveLength(1);
  expect(mocks.windows[0].options.parent).toBe('main');
  expect(mocks.windows[0].setFocus).toHaveBeenCalledOnce();
  mocks.channels[0].onmessage({ data: { type: 'hello' } });
  await flushPromises();
  expect(mocks.windows[0].show).toHaveBeenCalledOnce();
  mocks.channels[0].onmessage({ data: { type: 'finish', value: '文字' } });
  expect(await first.result).toBe('文字');
  expect(mocks.channels[0].close).toHaveBeenCalledOnce();
});

it('only registered actions run; mutation errors return to the requesting window', async () => {
  const save = vi.fn().mockRejectedValue(new Error('邮箱验证码不正确'));
  const handle = await openDialogWindow({ kind: 'password', title: '修改密码', actions: { save } });
  const receive = mocks.channels[0].onmessage;
  receive({ data: { type: 'action', request: 1, name: 'constructor' } });
  expect(mocks.channels[0].postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ request: 1, error: expect.any(String) }),
  );
  receive({ data: { type: 'action', request: 2, name: 'save', value: { code: '123456' } } });
  receive({ data: { type: 'finish' } });
  expect(mocks.windows[0].destroy).not.toHaveBeenCalled();
  await flushPromises();
  expect(save).toHaveBeenCalledOnce();
  expect(mocks.channels[0].postMessage).toHaveBeenCalledWith({
    type: 'reply',
    request: 2,
    error: '邮箱验证码不正确',
  });
  await handle.close();
});

it('scope disposal closes drafts, including a window still being created', async () => {
  const scope = effectScope();
  let open!: ReturnType<typeof useDesktopDialogs>;
  scope.run(() => {
    open = useDesktopDialogs();
  });
  const result = open({ kind: 'forward', title: '转发消息' });
  scope.stop();
  expect(await result).toBeUndefined();
  expect(mocks.windows[0].destroy).toHaveBeenCalledOnce();
});

it('read-only screen preview never prevents cancelling the picker', async () => {
  let resolve!: (value: number[]) => void;
  const handle = await openDialogWindow({
    kind: 'screen-picker',
    title: '选择共享内容',
    actions: {
      screen_share_preview: () =>
        new Promise<number[]>((done) => {
          resolve = done;
        }),
    },
  });
  const receive = mocks.channels[0].onmessage;
  receive({ data: { type: 'action', request: 1, name: 'screen_share_preview' } });
  await flushPromises();
  receive({ data: { type: 'finish' } });
  expect(await handle.result).toBeUndefined();
  resolve([]);
  await flushPromises();
});

it('different owner windows cannot share a dialog session', async () => {
  await openDialogWindow({ kind: 'annotation', title: '输入文字' });
  mocks.owner = 'media-call';
  await openDialogWindow({ kind: 'annotation', title: '输入文字' });
  expect(mocks.windows.map((w) => w.label)).toEqual([
    'dialog-main-annotation',
    'dialog-media-call-annotation',
  ]);
});

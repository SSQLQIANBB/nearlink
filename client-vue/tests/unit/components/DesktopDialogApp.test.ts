import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

const mocks = vi.hoisted(() => ({ setSize: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ setSize: mocks.setSize }),
  LogicalSize: class {
    constructor(public width: number, public height: number) {}
  },
}));
vi.mock('@/components/DesktopDialogContent.vue', () => ({
  default: { template: '<section class="desktop-dialog-content">内容</section>' },
}));
import DesktopDialogApp from '@/DesktopDialogApp.vue';

let notify: () => void;
let height = 200;
const disconnect = vi.fn();
let wrapper: ReturnType<typeof mount>;
beforeEach(() => {
  vi.useFakeTimers();
  mocks.setSize.mockClear();
  disconnect.mockClear();
  height = 200;
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { notify = callback; }
    observe() { notify(); }
    disconnect = disconnect;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ height }) as DOMRect,
  );
  vi.spyOn(screen, 'availHeight', 'get').mockReturnValue(800);
  wrapper = mount(DesktopDialogApp, { attachTo: document.body });
});
afterEach(() => {
  wrapper.unmount();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function resize() {
  notify();
  await vi.advanceTimersByTimeAsync(20);
  await flushPromises();
}

it('shrinks short content, grows after asynchronous content changes and caps at screen height', async () => {
  await resize();
  expect(mocks.setSize).toHaveBeenLastCalledWith(expect.objectContaining({ height: 200 }));
  height = 480;
  await resize();
  expect(mocks.setSize).toHaveBeenLastCalledWith(expect.objectContaining({ height: 480 }));
  height = 1200;
  await resize();
  expect(mocks.setSize).toHaveBeenLastCalledWith(expect.objectContaining({ height: 720 }));
});

it('does not keep retrying a size constrained by the operating system', async () => {
  await resize();
  await vi.advanceTimersByTimeAsync(100);
  expect(mocks.setSize).toHaveBeenCalledTimes(1);
});

it('disconnects the observer and cancels pending resize on exit', async () => {
  wrapper.unmount();
  await vi.advanceTimersByTimeAsync(100);
  expect(disconnect).toHaveBeenCalledOnce();
  expect(mocks.setSize).not.toHaveBeenCalled();
});

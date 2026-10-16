import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
const native = vi.hoisted(() => ({
  receive: null as null | ((event: { payload: { token: number; quality: string } }) => void),
  emitTo: vi.fn(async () => undefined),
  detach: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({
  emitTo: native.emitTo,
  listen: vi.fn(async (_event, handler) => {
    native.receive = handler;
    return native.detach;
  }),
}));
import DesktopShareOverlay from '../../../src/DesktopShareOverlay.vue';
let wrapper: VueWrapper | undefined;
afterEach(() => {
  wrapper?.unmount();
  history.replaceState({}, '', '/');
  vi.clearAllMocks();
});
describe('桌面悬浮工具栏画质', () => {
  it('本次选择完成后接受共享页的新画质，不将旧请求误判为切换失败', async () => {
    history.replaceState({}, '', '/?token=11');
    wrapper = mount(DesktopShareOverlay);
    await flushPromises();
    native.receive!({ payload: { token: 11, quality: 'high' } });
    await flushPromises();
    await wrapper.get('select').setValue('ultra');
    expect(native.emitTo).toHaveBeenLastCalledWith('media-call', 'desktop-share-quality', {
      token: 11,
      quality: 'ultra',
    });
    native.receive!({ payload: { token: 11, quality: 'ultra' } });
    native.receive!({ payload: { token: 11, quality: 'low' } });
    await flushPromises();
    expect(wrapper.get('select').element.value).toBe('low');
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    native.receive!({ payload: { token: 12, quality: 'high' } });
    await flushPromises();
    expect(wrapper.get('select').element.value).toBe('low');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import DesktopTitlebar from '@/components/DesktopTitlebar.vue';

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(), minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn(),
  install: vi.fn(), cleanup: vi.fn(),
}));
vi.mock('vue-router', () => ({ useRoute: () => ({ path: '/remote' }) }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: mocks.isTauri }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => mocks }));
vi.mock('@/services/desktopWindow', () => ({ installDesktopWindowControls: mocks.install }));

let wrapper: VueWrapper;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.isTauri.mockReturnValue(true);
  for (const action of [mocks.minimize, mocks.toggleMaximize, mocks.close]) action.mockResolvedValue(undefined);
  mocks.install.mockReturnValue(mocks.cleanup);
});
afterEach(() => {
  wrapper.unmount();
  vi.restoreAllMocks();
});

describe('平台窗口按钮', () => {
  it('Windows 按钮调用原生窗口操作，最大化状态更新为还原，卸载清理监听', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
    wrapper = mount(DesktopTitlebar);
    expect(wrapper.find('.desktop-window-drag-region').exists()).toBe(false);
    await wrapper.get('[aria-label="最小化"]').trigger('click');
    await wrapper.get('[aria-label="最大化"]').trigger('click');
    expect(mocks.minimize).toHaveBeenCalledOnce();
    expect(mocks.toggleMaximize).toHaveBeenCalledOnce();
    mocks.install.mock.calls[0]![0](true);
    await nextTick();
    await wrapper.get('[aria-label="还原"]').trigger('click');
    await wrapper.get('[aria-label="关闭窗口"]').trigger('click');
    expect(mocks.toggleMaximize).toHaveBeenCalledTimes(2);
    expect(mocks.close).toHaveBeenCalledOnce();
    wrapper.unmount();
    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });

  it('macOS 保持原来的透明拖动区，不渲染 Windows 按钮', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    wrapper = mount(DesktopTitlebar);
    expect(wrapper.findAll('[data-tauri-drag-region]')).toHaveLength(2);
    expect(wrapper.find('.desktop-window-controls').exists()).toBe(false);
    expect(mocks.install).toHaveBeenCalledWith(undefined);
  });

  it('桌面构建的浏览器预览不调用原生窗口操作', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
    mocks.isTauri.mockReturnValue(false);
    wrapper = mount(DesktopTitlebar);
    await wrapper.get('[aria-label="关闭窗口"]').trigger('click');
    expect(mocks.close).not.toHaveBeenCalled();
  });
});

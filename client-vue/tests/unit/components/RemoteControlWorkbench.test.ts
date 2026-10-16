import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NMessageProvider } from 'naive-ui';
import { defineComponent } from 'vue';

const mocks = vi.hoisted(() => ({ release: vi.fn(), probe: vi.fn() }));
vi.mock('@/api/remoteControl', () => ({
  getRemoteControlRelease: mocks.release,
  getRemoteSessions: vi.fn(),
}));
vi.mock('@/services/remoteControlCapabilities', async (original) => ({
  ...(await original<object>()),
  probeRemoteCapabilities: mocks.probe,
}));
vi.mock('@/stores/remoteControlHost', () => ({
  useRemoteControlHostStore: () => ({
    phase: 'offline',
    displayedDeviceCode: '',
    credentials: null,
  }),
}));
vi.mock('@/stores/remoteControlSession', () => ({
  useRemoteControlSessionStore: () => ({ visible: false }),
}));
vi.mock('@/stores/remoteDevices', () => ({ useRemoteDevicesStore: () => ({ busy: false }) }));
import RemoteControlWorkbench from '@/components/RemoteControlWorkbench.vue';
import { useRemoteControlStore } from '@/stores/remoteControl';

let wrapper: ReturnType<typeof mount>;
beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  mocks.release.mockResolvedValue({});
  mocks.probe.mockResolvedValue({
    runtime: 'web',
    native: null,
    canControl: true,
    canHostView: false,
    reason: 'READY',
  });
});
afterEach(() => wrapper?.unmount());

describe('远控能力刷新时的页面稳定性', () => {
  it('重复刷新保留说明和表单结构，期间仍禁止连接，失败后显示真实状态', async () => {
    wrapper = mount(
      defineComponent({
        components: { NMessageProvider, RemoteControlWorkbench },
        template: '<NMessageProvider><RemoteControlWorkbench /></NMessageProvider>',
      }),
    );
    await flushPromises();
    const remote = useRemoteControlStore();
    const hint = wrapper.get('.hint p').text();
    const refresh = wrapper.get('.refresh-capabilities');
    const icon = refresh.get('.icon-refresh').element;
    await wrapper.get('input[placeholder="请输入对方设备代码"]').setValue('900107723');
    await wrapper.get('input[placeholder="请输入临时密码"]').setValue('abcdefgh23');
    const submit = () => wrapper.get('button[type="submit"]');
    expect(submit().attributes('disabled')).toBeUndefined();
    for (let i = 0; i < 3; i++) {
      let finish!: (value: object) => void;
      mocks.release.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const pending = remote.refreshCapabilities();
      await wrapper.vm.$nextTick();
      expect(submit().attributes('disabled')).toBeDefined();
      expect(refresh.attributes('disabled')).toBeDefined();
      expect(refresh.attributes('aria-busy')).toBe('true');
      expect(refresh.findAll('.icon-refresh')).toHaveLength(1);
      expect(refresh.get('.icon-refresh').element).toBe(icon);
      expect(refresh.find('.n-base-loading').exists()).toBe(false);
      expect(wrapper.find('.connection-form > .hint').exists()).toBe(false);
      expect(wrapper.get('.hint p').text()).toBe(hint);
      finish({});
      await pending;
      await flushPromises();
      expect(submit().attributes('disabled')).toBeUndefined();
      expect(refresh.attributes('disabled')).toBeUndefined();
      expect(refresh.get('.icon-refresh').classes()).not.toContain('is-refreshing');
    }
    mocks.probe.mockResolvedValueOnce({
      runtime: 'web',
      native: null,
      canControl: false,
      canHostView: false,
      reason: 'RELEASE_UNAVAILABLE',
    });
    await remote.refreshCapabilities();
    await flushPromises();
    expect(wrapper.get('.connection-form > .hint').text()).toContain('暂时无法确认');
    expect(submit().attributes('disabled')).toBeDefined();
  });
});

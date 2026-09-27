import { mount, flushPromises } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/stores/remoteControl', () => ({ useRemoteControlStore: () => ({ capabilities: null }) }));
import { reactive } from 'vue';
const mocks = vi.hoisted(() => ({ store: null as any }));
vi.mock('@/stores/remoteDevices', () => ({ useRemoteDevicesStore: () => mocks.store }));
import RemoteDeviceSettings from '@/components/RemoteDeviceSettings.vue';
beforeEach(() => {
  mocks.store = reactive({ devices: [], support: { desktop: false, registration: false, identityReset: false }, loading: false, probing: false,
    phase: 'idle', busy: false, identityUnavailable: false, error: '', notice: '', initialize: vi.fn(), refresh: vi.fn(), register: vi.fn(), revoke: vi.fn(), cancel: vi.fn(), rebuildIdentity: vi.fn() });
});
const render = () => mount(RemoteDeviceSettings);
describe('远程设备设置界面', () => {
  it('Web只管理已有设备，不显示本机登记或控制操作', () => {
    const wrapper = render();
    expect(wrapper.text()).toContain('管理已有设备'); expect(wrapper.text()).not.toContain('登记当前设备');
    expect(wrapper.find('form').exists()).toBe(false); expect(wrapper.text()).not.toContain('请求控制');
    expect(mocks.store.initialize).toHaveBeenCalledOnce(); wrapper.unmount();
  });
  it('旧版桌面明确提示暂不支持，不提供失效登记按钮', () => {
    mocks.store.support.desktop = true;
    const wrapper = render(); expect(wrapper.text()).toContain('暂不支持设备登记');
    expect(wrapper.find('form').exists()).toBe(false); wrapper.unmount();
  });
  it('桌面显式提交设备别名；离开界面取消等待但不声称回滚', async () => {
    Object.assign(mocks.store.support, { desktop: true, registration: true });
    const wrapper = render(); await wrapper.get('input').setValue('我的电脑'); await wrapper.get('form').trigger('submit');
    expect(mocks.store.register).toHaveBeenCalledWith('我的电脑');
    expect(wrapper.text()).toContain('不代表设备在线'); wrapper.unmount(); expect(mocks.store.cancel).toHaveBeenCalledOnce();
  });
  it('只有身份不可用时显示显式重建，取消OS确认不会自动登记', async () => {
    Object.assign(mocks.store.support, { desktop: true, registration: true, identityReset: true });
    const wrapper = render(); expect(wrapper.text()).not.toContain('重建设备身份');
    mocks.store.identityUnavailable = true; await flushPromises();
    const button = wrapper.findAll('button').find(item => item.text() === '重建设备身份')!;
    await button.trigger('click'); expect(mocks.store.rebuildIdentity).toHaveBeenCalledOnce(); expect(mocks.store.register).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});

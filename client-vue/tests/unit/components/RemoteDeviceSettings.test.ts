import { mount, flushPromises } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/stores/remoteControl', () => ({ useRemoteControlStore: () => ({ capabilities: null }) }));
import { reactive } from 'vue';
const mocks = vi.hoisted(() => ({ store: null as any, auth: { authGeneration: 1 } }));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => mocks.auth }));
vi.mock('@/stores/remoteDevices', () => ({ useRemoteDevicesStore: () => mocks.store }));
import RemoteDeviceSettings from '@/components/RemoteDeviceSettings.vue';
beforeEach(() => {
  mocks.store = reactive({ devices: [], support: { desktop: false, registration: false, identityReset: false }, loading: false, probing: false,
    localDeviceId: null, identify: vi.fn(), phase: 'idle', busy: false, identityUnavailable: false, error: '', notice: '', initialize: vi.fn(), refresh: vi.fn(), register: vi.fn(), revoke: vi.fn(), rename: vi.fn().mockResolvedValue(true), cancel: vi.fn(), rebuildIdentity: vi.fn() });
});
const render = () => mount(RemoteDeviceSettings);
describe('远程设备设置界面', () => {
  it('识别入口只对支持客户端显示，成功记录展示本机标记', async () => {
    const wrapper = render(); expect(wrapper.text()).not.toContain('识别本机设备');
    Object.assign(mocks.store.support, { desktop: true, identification: true });
    mocks.store.devices = [{ deviceId: 'device-1', alias: '本机', platform: 'macos', revokedAt: null }];
    await flushPromises(); await wrapper.findAll('button').find(item => item.text() === '识别本机设备')!.trigger('click');
    expect(mocks.store.identify).toHaveBeenCalledOnce(); mocks.store.localDeviceId = 'device-1'; await flushPromises();
    expect(wrapper.text()).toContain('本机（已验证）'); wrapper.unmount();
  });
  it('组合名称、登记状态和系统筛选，区分无设备和无匹配结果', async () => {
    mocks.store.devices = [
      { deviceId: '1', alias: 'Office Mac', platform: 'macos', revokedAt: null },
      { deviceId: '2', alias: 'Office PC', platform: 'windows', revokedAt: '2026-09-28' },
      { deviceId: '3', alias: 'Home PC', platform: 'windows', revokedAt: null },
    ];
    const wrapper = render();
    await wrapper.get('.device-filters input').setValue(' OFFICE ');
    expect(wrapper.findAll('li')).toHaveLength(2);
    await wrapper.get('[aria-label="系统筛选"]').setValue('windows');
    expect(wrapper.findAll('li')).toHaveLength(1); expect(wrapper.get('li').text()).toContain('Office PC');
    await wrapper.get('[aria-label="登记状态筛选"]').setValue('active');
    expect(wrapper.text()).toContain('没有符合条件'); expect(wrapper.text()).not.toContain('尚无已登记设备');
    await wrapper.findAll('button').find(button => button.text() === '清除筛选')!.trigger('click');
    expect(wrapper.findAll('li')).toHaveLength(3); wrapper.unmount();
  });
  it('已有设备可编辑名称，保存后关闭编辑区，已撤销设备没有入口', async () => {
    mocks.store.devices = [{ deviceId: 'device-1', alias: '办公 Mac', platform: 'macos', revokedAt: null }];
    const wrapper = render();
    await wrapper.findAll('button').find(button => button.text() === '重命名')!.trigger('click');
    expect(wrapper.get<HTMLInputElement>('.rename-form input').element.value).toBe('办公 Mac');
    await wrapper.get('.rename-form input').setValue('家用 Mac'); await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(mocks.store.rename).toHaveBeenCalledWith('device-1', '家用 Mac'); expect(wrapper.find('form').exists()).toBe(false);
    mocks.store.devices[0].revokedAt = '2026-09-28'; await flushPromises();
    expect(wrapper.text()).not.toContain('重命名'); wrapper.unmount();
  });
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

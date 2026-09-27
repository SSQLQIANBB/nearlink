import { mount, flushPromises } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@/stores/remoteControlHost', () => ({ useRemoteControlHostStore: () => ({ phase: 'offline', error: '', start: vi.fn(), stop: vi.fn() }) }));
vi.mock('@/stores/remoteControl', () => ({ useRemoteControlStore: () => ({ capabilities: { canHostView: true } }) }));
vi.mock('@/stores/socket', () => ({ useSocketStore: () => ({ userList: [] }) }));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ currentUser: { id: 1 } }) }));
vi.mock('@/api/remoteControl', () => ({ getAssistanceGrants: vi.fn(async () => ({ grants: [] })), createAssistanceGrant: vi.fn(), revokeAssistanceGrant: vi.fn() }));
import RemoteHostSettings from '@/components/RemoteHostSettings.vue';
beforeEach(() => { mocks.invoke.mockReset(); });
const render = () => mount(RemoteHostSettings, { props: { devices: [] } });
describe('记住远程协助确认', () => {
  it('恢复确认只调用原生清除接口，成功后展示结果', async () => {
    mocks.invoke.mockResolvedValue(undefined);
    const wrapper = render();
    const button = wrapper.findAll('button').find(b => b.text() === '恢复每次确认')!;
    await button.trigger('click'); await flushPromises();
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('remote_control_clear_remembered_approvals');
    expect(wrapper.get('[role="status"]').text()).toContain('下次协助请求将重新弹窗');
    wrapper.unmount();
  });
  it('清除失败不声称已恢复、不输出底层异常', async () => {
    mocks.invoke.mockRejectedValue(new Error('private path or credential'));
    const wrapper = render();
    await wrapper.findAll('button').find(b => b.text() === '恢复每次确认')!.trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    expect(wrapper.get('[role="alert"]').text()).toContain('未能清除');
    expect(wrapper.text()).not.toContain('private path');
    wrapper.unmount();
  });
});

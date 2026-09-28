import { flushPromises, mount } from '@vue/test-utils';
import { reactive } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), auth: null as any }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => mocks.auth }));
import RememberedApprovalSettings from '@/components/RememberedApprovalSettings.vue';
const record = { id: 'a'.repeat(64), hostDeviceId: '11111111-1111-4111-8111-111111111111', controllerUserId: 2, scope: 'view' };
beforeEach(() => {
  mocks.invoke.mockReset(); mocks.auth = reactive({ currentUser: { id: 1 }, authGeneration: 1, loggingOut: false });
});
const render = () => mount(RememberedApprovalSettings, { props: { resetVersion: 0 } });
describe('本机记忆授权管理', () => {
  it('显式读取后按原生返回的记录撤销，不能新增或扩大范围', async () => {
    mocks.invoke.mockResolvedValueOnce([record]).mockResolvedValueOnce(undefined);
    const wrapper = render(); expect(mocks.invoke).not.toHaveBeenCalled();
    await wrapper.get('button').trigger('click'); await flushPromises();
    expect(mocks.invoke).toHaveBeenCalledWith('remote_control_list_remembered_approvals', { userId: 1 });
    expect(wrapper.text()).toContain('账号 2'); expect(wrapper.text()).toContain('仅观看');
    await wrapper.findAll('button').find(item => item.text() === '恢复对此记录的确认')!.trigger('click'); await flushPromises();
    expect(mocks.invoke).toHaveBeenLastCalledWith('remote_control_remove_remembered_approval', { userId: 1, id: record.id });
    expect(wrapper.findAll('li')).toHaveLength(0); expect(wrapper.text()).toContain('当前会话不会结束'); wrapper.unmount();
  });
  it('账号切换与全部清除使旧结果失效', async () => {
    let resolve!: (result: unknown) => void;
    mocks.invoke.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const wrapper = render(); await wrapper.get('button').trigger('click');
    mocks.auth.authGeneration++; mocks.auth.currentUser.id = 3; await flushPromises();
    resolve([record]); await flushPromises(); expect(wrapper.findAll('li')).toHaveLength(0);
    mocks.invoke.mockResolvedValueOnce([record]); await wrapper.get('button').trigger('click'); await flushPromises();
    expect(wrapper.findAll('li')).toHaveLength(1); await wrapper.setProps({ resetVersion: 1 });
    expect(wrapper.findAll('li')).toHaveLength(0); wrapper.unmount();
  });
  it('旧客户端、无效响应和撤销失败不显示成功或底层数据', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('private key path'));
    const wrapper = render(); await wrapper.get('button').trigger('click'); await flushPromises();
    expect(wrapper.text()).toContain('最新版桌面客户端'); expect(wrapper.text()).not.toContain('private key path');
    mocks.invoke.mockResolvedValueOnce([{ ...record, scope: 'admin' }]); await wrapper.get('button').trigger('click'); await flushPromises();
    expect(wrapper.findAll('li')).toHaveLength(0);
    mocks.invoke.mockResolvedValueOnce([record]); await wrapper.get('button').trigger('click'); await flushPromises();
    mocks.invoke.mockRejectedValueOnce(new Error('disk full'));
    await wrapper.findAll('button').find(item => item.text() === '恢复对此记录的确认')!.trigger('click'); await flushPromises();
    expect(wrapper.findAll('li')).toHaveLength(1); expect(wrapper.text()).toContain('未能确认删除结果');
    expect(wrapper.text()).not.toContain('disk full'); wrapper.unmount();
  });
});

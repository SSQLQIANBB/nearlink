import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
  info: vi.fn(),
  push: vi.fn(),
  destroy: vi.fn(),
  startRingtone: vi.fn(),
  stopRingtone: vi.fn(),
}));
vi.mock('naive-ui', () => ({ useDialog: () => ({ info: mocks.info }) }));
vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: mocks.push,
    currentRoute: { value: { path: '/remote' } },
  }),
}));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ currentUser: { id: 2 } }) }));
vi.mock('@/stores/socket', () => ({
  useSocketStore: () => ({
    socket: {
      on: (event: string, handler: Function) => mocks.handlers.set(event, handler),
      off: (event: string) => mocks.handlers.delete(event),
    },
  }),
}));
vi.mock('@/services/notificationService', () => ({
  default: {
    showCall: vi.fn(),
    startCallRingtone: mocks.startRingtone,
    stopCallRingtone: mocks.stopRingtone,
  },
}));
import GroupCallInvitations from '../../../src/components/GroupCallInvitations.vue';

const session = {
  groupId: 7,
  ownerUserId: 1,
  startedAt: '2026-09-12',
  user: { nickname: 'Alice' },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  mocks.info.mockReturnValue({ destroy: mocks.destroy });
});

describe('群组通话全局邀请', () => {
  it.each(['video', 'audio', 'screen'])('在其他页面收到 %s 邀请，接受后进入对应会话', (type) => {
    const wrapper = mount(GroupCallInvitations);
    mocks.handlers.get('group_call_started')!({ ...session, type });
    expect(mocks.info).toHaveBeenCalledOnce();
    const options = mocks.info.mock.calls[0]![0];
    expect(options.content).toContain('Alice');
    expect(mocks.startRingtone).toHaveBeenCalledWith(`group:7:${type}:2026-09-12`);
    expect(mocks.push).not.toHaveBeenCalled();
    options.onPositiveClick();
    expect(mocks.stopRingtone).toHaveBeenCalledWith(`group:7:${type}:2026-09-12`);
    expect(mocks.push).toHaveBeenCalledWith(`/group-${type}/7`);
    wrapper.unmount();
  });

  it('不向发起人弹窗，重复事件不重复邀请，暂不加入不跳转', () => {
    const wrapper = mount(GroupCallInvitations);
    const started = mocks.handlers.get('group_call_started')!;
    started({ ...session, type: 'video', ownerUserId: 2 });
    expect(mocks.info).not.toHaveBeenCalled();
    started({ ...session, type: 'video' });
    started({ ...session, type: 'video' });
    expect(mocks.info).toHaveBeenCalledOnce();
    mocks.info.mock.calls[0]![0].onNegativeClick();
    expect(mocks.push).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('会话结束时撤回弹窗，组件销毁时移除监听', () => {
    const wrapper = mount(GroupCallInvitations);
    mocks.handlers.get('group_call_started')!({ ...session, type: 'screen' });
    mocks.handlers.get('group_call_ended')!({ groupId: 7, type: 'screen' });
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(mocks.stopRingtone).toHaveBeenCalledWith('group:7:screen:2026-09-12');
    wrapper.unmount();
    expect(mocks.handlers.size).toBe(0);
  });
});

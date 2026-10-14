import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
  create: vi.fn(),
  push: vi.fn(),
  receivePrivate: vi.fn(() => true),
  receiveGroup: vi.fn(() => true),
  shouldNotify: vi.fn((_type: string) => true),
  previewMessage: vi.fn((value: string) => value),
  playAlert: vi.fn(),
}));
vi.mock('naive-ui', () => ({ useNotification: () => ({ create: mocks.create }) }));
vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-router')>()),
  useRouter: () => ({ push: mocks.push, currentRoute: { value: { path: '/groups' } } }),
}));
vi.mock('@/stores/socket', () => ({
  useSocketStore: () => ({
    authenticated: false,
    userList: [],
    setSubscribedGroups: vi.fn(),
    socket: {
      on: (event: string, handler: Function) => mocks.handlers.set(event, handler),
      off: (event: string) => mocks.handlers.delete(event),
    },
  }),
}));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ currentUser: null }) }));
vi.mock('@/stores/unread', () => ({
  useUnreadStore: () => ({
    total: 0,
    activePrivateUserId: null,
    rememberSender: vi.fn(),
    receivePrivate: mocks.receivePrivate,
    receiveGroup: mocks.receiveGroup,
  }),
}));
vi.mock('@/services/notificationService', () => ({
  default: {
    showMessage: vi.fn(),
    showGroupMessage: vi.fn(),
    playAlert: mocks.playAlert,
    shouldNotify: mocks.shouldNotify,
    previewMessage: mocks.previewMessage,
  },
}));
import GlobalMessages from '../../../src/components/GlobalMessages.vue';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  mocks.shouldNotify.mockImplementation(() => true);
  mocks.previewMessage.mockImplementation((value: string) => value);
});

describe('全局消息提示', () => {
  it('私信和群消息显示发送人及单行内容，点击内容进入会话', () => {
    const wrapper = mount(GlobalMessages);
    mocks.handlers.get('private_message')!({
      id: 11,
      fromUserId: 2,
      sender: { nickname: '小明' },
      message: '你好',
    });
    mocks.handlers.get('group_message')!({
      id: 12,
      groupId: 7,
      user: { nickname: '小红' },
      message: '开会了',
    });

    expect(mocks.create).toHaveBeenCalledTimes(2);
    const privateOptions = mocks.create.mock.calls[0]![0];
    const groupOptions = mocks.create.mock.calls[1]![0];
    expect(privateOptions.closable).toBe(false);
    expect(groupOptions.closable).toBe(false);
    expect(privateOptions.title().children).toBe('小明：消息');
    expect(groupOptions.title().children).toBe('小红：消息');
    expect(privateOptions.title().props.style.color).toBe('#f8fafc');
    const privateContent = privateOptions.content();
    const groupContent = groupOptions.content();
    expect(privateContent.children).toBe('内容：你好');
    expect(groupContent.children).toBe('内容：开会了');
    expect(privateContent.props.style.color).toBe('#dbeafe');
    privateContent.props.onClick();
    groupContent.props.onClick();
    expect(mocks.push).toHaveBeenCalledWith({
      path: '/remote',
      query: { tab: 'users', contact: '2' },
    });
    expect(mocks.push).toHaveBeenCalledWith('/group-chat/7');
    wrapper.unmount();
  });

  it('关闭群消息提醒只保留未读计数，关闭预览时隐藏私聊正文', () => {
    mocks.shouldNotify.mockImplementation((type) => type !== 'group');
    mocks.previewMessage.mockReturnValue('收到一条私聊消息');
    const wrapper = mount(GlobalMessages);
    mocks.handlers.get('private_message')!({
      id: 21,
      fromUserId: 2,
      sender: { nickname: '小明' },
      message: '秘密',
    });
    mocks.handlers.get('group_message')!({
      id: 22,
      groupId: 7,
      user: { nickname: '小红' },
      message: '群内秘密',
    });

    expect(mocks.receiveGroup).toHaveBeenCalledWith(22, 7, false);
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.create.mock.calls[0]![0].content().children).toBe('内容：收到一条私聊消息');
    expect(mocks.playAlert).toHaveBeenCalledWith('private');
    wrapper.unmount();
  });
});

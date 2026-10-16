import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
const mock = vi.hoisted(() => ({
  send: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  writeText: vi.fn(),
  ack: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
}));
vi.mock('@/stores/socket', () => ({
  useSocketStore: () => ({
    socket: {
      connected: true,
      on: mock.on,
      off: mock.off,
      timeout: () => ({ emitWithAck: mock.ack }),
    },
  }),
}));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ currentUser: { id: 1 } }) }));
vi.mock('@/services/reliableMessage', () => ({ sendReliableMessage: mock.send }));
vi.mock('@/api/auth', () => ({
  getUserList: async () => ({ users: [{ id: 2, username: '小李' }] }),
}));
vi.mock('@/api/group', () => ({
  getMyGroups: async () => ({ groups: [{ id: 7, name: '测试群' }] }),
}));
vi.mock('naive-ui', async (original) => ({
  ...(await original<typeof import('naive-ui')>()),
  useMessage: () => ({ success: vi.fn(), error: mock.error, warning: vi.fn() }),
  useDialog: () => ({ warning: mock.warning }),
}));
import ChatMessageActions from '../../../src/components/ChatMessageActions.vue';
const items = [
  { id: 1, message: '原文', senderName: '小李' },
  { id: 2, message: '第二条', senderName: '我' },
];
const wrappers: ReturnType<typeof mount>[] = [];
function setup() {
  const wrapper = mount(ChatMessageActions, {
    props: { kind: 'private', conversationId: 2, messages: items },
    global: {
      stubs: {
        NDropdown: {
          name: 'NDropdown',
          props: ['show', 'options'],
          emits: ['select'],
          template: '<div />',
        },
        NModal: { props: ['show'], template: '<div v-if="show"><slot /></div>' },
        NInput: {
          props: ['value'],
          emits: ['update:value'],
          template:
            '<input :value="value" @input="$emit(\'update:value\', $event.target.value)" />',
        },
        NButton: {
          props: ['disabled'],
          template: '<button :disabled="disabled"><slot /></button>',
        },
        NAvatar: true,
        NTag: true,
        NEmpty: true,
      },
    },
  });
  wrappers.push(wrapper);
  return wrapper;
}
function event(type = 'mouse') {
  const element = document.createElement('div');
  element.innerHTML = '<div class="chat-text">原文</div>';
  return {
    pointerType: type,
    clientX: 100,
    clientY: 100,
    currentTarget: element,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as any;
}
async function choose(wrapper: ReturnType<typeof setup>, key: string, index = 0) {
  wrapper.vm.open(event(), items[index]!);
  await nextTick();
  expect(
    wrapper
      .findComponent({ name: 'NDropdown' })
      .props('options')
      .find((option: any) => option.key === key)?.disabled,
  ).not.toBe(true);
  wrapper.findComponent({ name: 'NDropdown' }).vm.$emit('select', key);
  await flushPromises();
}
beforeEach(() => {
  vi.clearAllMocks();
  mock.send.mockResolvedValue({ ok: true, id: 10 });
  mock.ack.mockResolvedValue({ ok: true });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: mock.writeText.mockResolvedValue(undefined) },
  });
});
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.useRealTimers();
});
describe('聊天菜单交互', () => {
  it('关闭状态的真实下拉菜单仍使用坐标定位，无需触发元素', () => {
    const wrapper = mount(ChatMessageActions, {
      props: { kind: 'private', conversationId: 2, messages: items },
      global: { stubs: { NModal: true } },
    });
    wrappers.push(wrapper);
    expect(wrapper.exists()).toBe(true);
  });
  it('长按打开，滑动与卸载取消计时，长按后的点击不触发媒体', async () => {
    vi.useFakeTimers();
    const wrapper = setup();
    wrapper.vm.pointerDown(event('touch'), items[0]!);
    wrapper.vm.pointerMove({ clientX: 120, clientY: 100 } as PointerEvent);
    await vi.advanceTimersByTimeAsync(600);
    expect(wrapper.findComponent({ name: 'NDropdown' }).props('show')).toBe(false);
    wrapper.vm.pointerDown(event('touch'), items[0]!);
    await vi.advanceTimersByTimeAsync(500);
    expect(wrapper.findComponent({ name: 'NDropdown' }).props('show')).toBe(true);
    const click = event();
    wrapper.vm.click(click, items[0]!);
    expect(click.preventDefault).toHaveBeenCalled();
    wrapper.vm.pointerDown(event('touch'), items[0]!);
    wrapper.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('复制正文，引用可消费且切换会话时清空', async () => {
    const wrapper = setup();
    await choose(wrapper, 'copy');
    expect(mock.writeText).toHaveBeenCalledWith('原文');
    await choose(wrapper, 'quote');
    expect(wrapper.text()).toContain('小李:');
    expect(wrapper.vm.takeQuote()).toMatchObject({ kind: 'private', id: 1, message: '原文' });
    expect(wrapper.vm.takeQuote()).toBeUndefined();
    await choose(wrapper, 'quote');
    await wrapper.setProps({ conversationId: 3 });
    expect(wrapper.vm.takeQuote()).toBeUndefined();
  });
  it('多选删除确认后发请求，失败保留消息，远端删除同步清理', async () => {
    const wrapper = setup();
    await choose(wrapper, 'select');
    wrapper.vm.click(event(), items[1]!);
    await nextTick();
    expect(wrapper.vm.selectedIds).toEqual([1, 2]);
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '删除')!
      .trigger('click');
    const options = mock.warning.mock.calls[0]![0];
    expect(options.content).toBe('所选消息将从你的所有设备上删除');
    expect(mock.ack).not.toHaveBeenCalled();
    mock.ack.mockResolvedValueOnce({ ok: false, error: '失败' });
    expect(await options.onPositiveClick()).toBe(false);
    expect(wrapper.emitted('deleted')).toBeUndefined();
    await options.onPositiveClick();
    expect(mock.ack).toHaveBeenCalledWith('messages_delete', { kind: 'private', ids: [1, 2] });
    expect(wrapper.emitted('deleted')?.[0]).toEqual([[1, 2]]);
    mock.on.mock.calls[0]![1]({ kind: 'private', ids: [2] });
    expect(wrapper.emitted('deleted')?.[1]).toEqual([[2]]);
  });
  it('按列表顺序转发，失败重试沿用消息标识并跳过成功条目', async () => {
    const wrapper = setup();
    await choose(wrapper, 'select');
    wrapper.vm.click(event(), items[1]!);
    await nextTick();
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '逐条转发')!
      .trigger('click');
    await flushPromises();
    await wrapper.find('input[type="checkbox"]').setValue(true);
    mock.send
      .mockResolvedValueOnce({ ok: true, id: 20 })
      .mockResolvedValueOnce({ ok: false, error: '网络超时' });
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '发送')!
      .trigger('click');
    await flushPromises();
    expect(mock.send.mock.calls.map((call) => call[2].forward.id)).toEqual([1, 2]);
    const failedId = mock.send.mock.calls[1]![2].clientMessageId;
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '发送')!
      .trigger('click');
    await flushPromises();
    expect(mock.send.mock.calls[2]![2]).toMatchObject({
      forward: { kind: 'private', id: 2 },
      clientMessageId: failedId,
    });
    expect(mock.send).toHaveBeenCalledTimes(3);
    expect(wrapper.emitted('forwarded')).toHaveLength(1);
  });
});

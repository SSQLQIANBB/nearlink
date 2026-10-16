import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { defineComponent, h, nextTick } from 'vue';
import { NButton } from 'naive-ui';

const mocks = vi.hoisted(() => ({
  release: vi.fn(),
  probe: vi.fn(),
  push: vi.fn(),
}));
vi.mock('@/api/remoteControl', () => ({
  getRemoteControlRelease: mocks.release,
  getRemoteSessions: vi.fn(),
}));
vi.mock('@/services/remoteControlCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/remoteControlCapabilities')>()),
  probeRemoteCapabilities: mocks.probe,
}));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/features/screenShare', () => ({ openScreenShare: vi.fn() }));
vi.mock('naive-ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('naive-ui')>()),
  useMessage: () => ({ error: vi.fn() }),
}));

import ToolBar from '@/views/remoteShare/components/ToolBar.vue';
import { useRemoteControlStore } from '@/stores/remoteControl';
import { usePrivateCallStore } from '@/stores/privateCall';
import { mediaOccupancy } from '@/services/mediaOccupancy';

const Tooltip = defineComponent({
  props: { disabled: Boolean },
  setup:
    (props, { slots }) =>
    () =>
      h('div', [
        slots.trigger?.(),
        !props.disabled && h('div', { role: 'tooltip' }, slots.default?.()),
      ]),
});
let wrapper: VueWrapper | undefined;

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  mocks.release.mockResolvedValue({});
  mocks.probe.mockResolvedValue({
    runtime: 'web',
    native: null,
    showControllerEntry: true,
    showHostEntry: false,
    canControl: true,
    canHostView: false,
    canHostControl: false,
    reason: 'READY',
  });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  mediaOccupancy.stop('test-cleanup');
});

async function openToolbar() {
  await useRemoteControlStore().refreshCapabilities();
  wrapper = mount(ToolBar, {
    props: { contactUser: { id: 42, socketId: 'peer' } },
    global: { stubs: { Tooltip } },
  });
  return wrapper.findAllComponents(NButton).find((button) => button.text() === '远程控制')!;
}

describe('个人聊天远程控制入口', () => {
  it('局域网 HTTP 能力受限时展示 HTTPS 提示且不能导航', async () => {
    mocks.probe.mockResolvedValueOnce({
      showControllerEntry: true,
      canControl: false,
      reason: 'INSECURE_CONTEXT',
    });
    const button = await openToolbar();
    expect(button.get('button').element.disabled).toBe(true);
    expect(wrapper!.get('[role="tooltip"]').text()).toBe(
      '远程控制需要安全连接，请使用 HTTPS 地址访问；局域网 HTTP 地址不支持远程控制。',
    );
    expect(button.element.parentElement?.tagName).toBe('SPAN');
    button.vm.$emit('click');
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('HTTPS 能力就绪后入口可用，导航携带当前聊天用户', async () => {
    const button = await openToolbar();
    expect(button.get('button').element.disabled).toBe(false);
    expect(wrapper!.find('[role="tooltip"]').exists()).toBe(false);
    await button.trigger('click');
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith({
      name: 'RemoteControl',
      query: { userId: 42 },
    });
  });

  it.each(['private-call', 'media'] as const)('%s 占用期间禁止按钮和导航', async (kind) => {
    const button = await openToolbar();
    if (kind === 'private-call') usePrivateCallStore().busy = true;
    else mediaOccupancy.acquire('group-call', 'another-call');
    await nextTick();
    expect(button.get('button').element.disabled).toBe(true);
    expect(wrapper!.find('[role="tooltip"]').exists()).toBe(false);
    button.vm.$emit('click');
    expect(mocks.push).not.toHaveBeenCalled();
  });
});

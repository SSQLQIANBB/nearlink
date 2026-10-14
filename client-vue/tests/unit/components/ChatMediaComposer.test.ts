import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  uploadFile: vi.fn(),
  stopTrack: vi.fn(),
  recorder: null as FakeMediaRecorder | null,
}));

vi.mock('@/api/common', () => ({ uploadFile: mocks.uploadFile }));
vi.mock('naive-ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('naive-ui')>()),
  useMessage: () => ({ error: vi.fn(), warning: vi.fn() }),
}));

class FakeMediaRecorder {
  static isTypeSupported() {
    return true;
  }
  state: RecordingState = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor() {
    mocks.recorder = this;
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['voice'], { type: this.mimeType }) } as BlobEvent);
    this.onstop?.();
  }
}

import ChatMediaComposer from '../../../src/components/ChatMediaComposer.vue';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.recorder = null;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: mocks.stopTrack }] }),
    },
  });
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  mocks.uploadFile.mockResolvedValue({
    file: {
      id: 1,
      fileUrl: 'https://files.example.com/voice.webm',
      mimeType: 'audio/webm',
      originalName: 'voice.webm',
      fileSize: 5,
    },
  });
});

describe('聊天语音录制', () => {
  it('按住开始录音，松开后上传并发送语音', async () => {
    const wrapper = mount(ChatMediaComposer, {
      global: {
        stubs: {
          NButton: { template: '<button><slot /></button>' },
          AudioWaveform: { template: '<span><slot /></span>' },
        },
      },
    });
    const button = wrapper.find('.hold-to-talk');

    expect(button.text()).toContain('按住');
    await button.trigger('pointerdown');
    await flushPromises();
    expect(button.text()).toContain('松开 发送');

    await button.trigger('pointerup');
    await flushPromises();
    expect(mocks.uploadFile).toHaveBeenCalledOnce();
    expect(wrapper.emitted('send')?.[0]?.[0]).toMatchObject({
      type: 'voice',
      media: { durationSeconds: 1 },
    });
    expect(mocks.stopTrack).toHaveBeenCalledOnce();
  });

  it('麦克风授权完成前松手时不再启动录音', async () => {
    let allowMicrophone!: (stream: MediaStream) => void;
    vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValueOnce(
      new Promise((resolve) => {
        allowMicrophone = resolve;
      }) as Promise<MediaStream>,
    );
    const wrapper = mount(ChatMediaComposer, {
      global: {
        stubs: {
          NButton: { template: '<button><slot /></button>' },
          AudioWaveform: { template: '<span><slot /></span>' },
        },
      },
    });
    const button = wrapper.find('.hold-to-talk');

    button.element.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await wrapper.vm.$nextTick();
    button.element.dispatchEvent(new Event('pointerup', { bubbles: true }));
    allowMicrophone({ getTracks: () => [{ stop: mocks.stopTrack }] } as unknown as MediaStream);
    await flushPromises();

    expect(mocks.recorder).toBeNull();
    expect(mocks.stopTrack).toHaveBeenCalledOnce();
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });
});

for (const moveBack of [false, true]) {
  it(moveBack ? '移回后恢复发送提示，卸载取消录音' : '上滑后松手取消发送', async () => {
    const wrapper = mount(ChatMediaComposer, {
      props: { compact: true },
      global: {
        stubs: {
          NButton: { template: '<button><slot /></button>' },
          AudioWaveform: { template: '<span><slot /></span>' },
        },
      },
    });
    await wrapper.get('.voice-mode-toggle').trigger('click');
    const button = wrapper.get('.hold-to-talk');
    const pointer = async (type: string, clientY: number) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperties(event, { clientY: { value: clientY }, pointerId: { value: 1 } });
      button.element.dispatchEvent(event);
      await wrapper.vm.$nextTick();
    };
    await pointer('pointerdown', 200);
    await flushPromises();
    await pointer('pointermove', 140);
    expect(wrapper.get('.hold-to-talk').text()).toContain('松开取消');
    if (moveBack) {
      await pointer('pointermove', 190);
      expect(wrapper.get('.hold-to-talk').text()).toContain('松开 发送');
      wrapper.unmount();
    } else {
      await pointer('pointerup', 140);
      expect(wrapper.get('.hold-to-talk').text()).toContain('按住 说话');
      wrapper.unmount();
    }
    await flushPromises();
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(mocks.stopTrack).toHaveBeenCalledOnce();
  });
}

it('点击麦克风只切换模式，不申请权限，再次点击恢复文字草稿', async () => {
  const wrapper = mount(ChatMediaComposer, {
    props: { compact: true },
    slots: { default: '<input value="保留的草稿" />' },
    global: { stubs: { NButton: { template: '<button><slot /></button>' } } },
  });
  expect(wrapper.find('.hold-to-talk').exists()).toBe(false);
  await wrapper.get('.voice-mode-toggle').trigger('click');
  expect(wrapper.get('.hold-to-talk').text()).toContain('按住 说话');
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  await wrapper.get('.voice-mode-toggle').trigger('click');
  expect(wrapper.get('input[value]').element.getAttribute('value')).toBe('保留的草稿');
  wrapper.unmount();
});

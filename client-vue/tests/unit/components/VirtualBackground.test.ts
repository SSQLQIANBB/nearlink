import { shallowMount, flushPromises } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  close: vi.fn(),
  videoStop: vi.fn(),
  cameraStop: vi.fn(),
  audioStop: vi.fn(),
  results: null as null | ((result: any) => void),
}));
vi.mock('@/services/backgroundProcessor', () => ({
  createSegmenter: mocks.create,
  composeBackground: vi.fn(),
  stopProcessedVideo: (stream: MediaStream | null) =>
    stream?.getVideoTracks().forEach((track) => track.stop()),
}));
vi.mock('naive-ui', () => ({
  useMessage: () => ({ info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() }),
}));
import VirtualBackground from '../../../src/components/VirtualBackground.vue';
const camera = { kind: 'video', stop: mocks.cameraStop };
const audio = { kind: 'audio', stop: mocks.audioStop };
const raw = {
  getVideoTracks: () => [camera],
  getAudioTracks: () => [audio],
} as unknown as MediaStream;
const output = {
  getVideoTracks: () => [{ stop: mocks.videoStop }],
  addTrack: vi.fn(),
} as unknown as MediaStream;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.close.mockResolvedValue(undefined);
  mocks.create.mockResolvedValue({
    close: mocks.close,
    onResults: (fn: (result: any) => void) => {
      mocks.results = fn;
    },
    send: async () => mocks.results!({}),
  });
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    {} as CanvasRenderingContext2D,
  );
  Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', {
    configurable: true,
    value: () => output,
  });
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

describe('背景流生命周期', () => {
  it('不再提供模糊背景选项', () => {
    const wrapper = shallowMount(VirtualBackground, {
      props: { stream: raw },
      global: {
        stubs: Object.fromEntries(
          [
            'NIcon',
            'NButton',
            'NText',
            'NCard',
            'NSlider',
            'NSpace',
            'NColorPicker',
            'NUpload',
            'NPopover',
          ].map((name) => [name, true]),
        ),
      },
    });
    expect(wrapper.text()).not.toContain('模糊背景');
    wrapper.unmount();
  });

  it('应用效果保留麦克风，关闭效果恢复同一个原始摄像头流', async () => {
    const wrapper = shallowMount(VirtualBackground, {
      props: { stream: raw },
      global: {
        stubs: Object.fromEntries(
          [
            'NIcon',
            'NButton',
            'NText',
            'NCard',
            'NSlider',
            'NSpace',
            'NColorPicker',
            'NUpload',
            'NPopover',
          ].map((name) => [name, true]),
        ),
      },
    });
    await wrapper.vm.applyEffect('color');
    await flushPromises();
    expect(wrapper.emitted('stream-updated')?.[0]?.[0]).toBe(output);
    expect(output.addTrack).toHaveBeenCalledWith(audio);
    await wrapper.vm.applyEffect('none');
    expect(wrapper.emitted('stream-updated')?.slice(-1)[0]?.[0]).toBe(raw);
    expect(mocks.videoStop).toHaveBeenCalledOnce();
    expect(mocks.cameraStop).not.toHaveBeenCalled();
    expect(mocks.audioStop).not.toHaveBeenCalled();
    wrapper.unmount();
  });
  it('切换样式复用处理器，不叠加捕获循环', async () => {
    const wrapper = shallowMount(VirtualBackground, {
      props: { stream: raw },
      global: {
        stubs: Object.fromEntries(
          [
            'NIcon',
            'NButton',
            'NText',
            'NCard',
            'NSlider',
            'NSpace',
            'NColorPicker',
            'NUpload',
            'NPopover',
          ].map((name) => [name, true]),
        ),
      },
    });
    await wrapper.vm.applyEffect('color');
    await wrapper.vm.applyEffect('image');
    expect(mocks.create).toHaveBeenCalledOnce();
    wrapper.unmount();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it('模型失败时保留原画面，不切换到空画布', async () => {
    mocks.create.mockRejectedValueOnce(new Error('model unavailable'));
    const wrapper = shallowMount(VirtualBackground, {
      props: { stream: raw },
      global: {
        stubs: Object.fromEntries(
          [
            'NIcon',
            'NButton',
            'NText',
            'NCard',
            'NSlider',
            'NSpace',
            'NColorPicker',
            'NUpload',
            'NPopover',
          ].map((name) => [name, true]),
        ),
      },
    });
    await wrapper.vm.applyEffect('color');
    expect(wrapper.emitted('stream-updated')?.slice(-1)[0]?.[0]).toBe(raw);
    expect(mocks.cameraStop).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});

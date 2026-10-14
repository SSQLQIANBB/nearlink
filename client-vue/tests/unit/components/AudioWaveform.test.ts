import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import AudioWaveform from '@/components/AudioWaveform.vue';

afterEach(() => vi.unstubAllGlobals());
it('音量增大时声柱增高，卸载时释放分析资源但不停止录音轨道', async () => {
  let amplitude = 0;
  let nextFrame: FrameRequestCallback = () => {};
  const disconnect = vi.fn();
  const close = vi.fn().mockResolvedValue(undefined);
  const stopTrack = vi.fn();
  const analyser = {
    fftSize: 256,
    disconnect,
    getFloatTimeDomainData: (samples: Float32Array) => samples.fill(amplitude),
  };
  vi.stubGlobal(
    'AudioContext',
    class {
      createAnalyser() {
        return analyser;
      }
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect };
      }
      resume() {
        return Promise.resolve();
      }
      close = close;
    },
  );
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      nextFrame = callback;
      return 42;
    }),
  );
  const cancel = vi.fn();
  vi.stubGlobal('cancelAnimationFrame', cancel);
  const wrapper = mount(AudioWaveform, {
    props: { stream: { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream },
  });
  await flushPromises();
  const bar = wrapper.get('.audio-waveform__side i');
  const quiet = parseFloat((bar.element as HTMLElement).style.height);
  amplitude = 0.2;
  nextFrame(16);
  await wrapper.vm.$nextTick();
  expect(parseFloat((bar.element as HTMLElement).style.height)).toBeGreaterThan(quiet);
  wrapper.unmount();
  expect(cancel).toHaveBeenCalledWith(42);
  expect(disconnect).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledOnce();
  expect(stopTrack).not.toHaveBeenCalled();
});

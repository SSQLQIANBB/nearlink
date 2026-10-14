<template>
  <span class="audio-waveform">
    <span
      v-for="side in 2"
      :key="side"
      class="audio-waveform__side"
      :class="{ 'audio-waveform__side--right': side === 2 }"
      aria-hidden="true"
    >
      <i
        v-for="(weight, index) in [0.55, 1, 0.8]"
        :key="index"
        :style="{ height: `${4 + (8 + level * 16) * weight}px` }"
      ></i>
    </span>
    <span class="audio-waveform__label"><slot /></span>
  </span>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

const props = defineProps<{ stream: MediaStream }>();
const level = ref(0);
let context: AudioContext | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let analyser: AnalyserNode | null = null;
let frame = 0;

function dispose() {
  cancelAnimationFrame(frame);
  source?.disconnect();
  analyser?.disconnect();
  if (context) void context.close();
  source = null;
  analyser = null;
  context = null;
  level.value = 0;
}

onMounted(() => {
  context = new AudioContext();
  analyser = context.createAnalyser();
  analyser.fftSize = 256;
  source = context.createMediaStreamSource(props.stream);
  // 只分析现有录音流，不连接扬声器，避免回声；音轨由录音组件释放。
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  const measure = () => {
    analyser!.getFloatTimeDomainData(samples);
    const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
    level.value = level.value * 0.3 + Math.min(1, rms * 5) * 0.7;
    frame = requestAnimationFrame(measure);
  };
  measure();
  // 音频分析受浏览器策略限制时恢复静态波形，不中断实际录音。
  void context.resume().catch(dispose);
});
onBeforeUnmount(dispose);
</script>

<style scoped>
.audio-waveform {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 26px;
  pointer-events: none;
}
.audio-waveform__side {
  display: flex;
  align-items: center;
  gap: 3px;
  height: 26px;
}
.audio-waveform__side i {
  display: block;
  width: 3px;
  border-radius: 3px;
  background: currentColor;
}
.audio-waveform__side--right {
  order: 2;
  transform: scaleX(-1);
}
.audio-waveform__label {
  display: flex;
  align-items: center;
  gap: 6px;
}
</style>

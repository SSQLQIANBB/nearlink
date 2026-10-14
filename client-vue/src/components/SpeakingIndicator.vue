<template>
  <span
    v-if="speaking"
    class="inline-flex items-center gap-1 ml-1 text-emerald-400 text-xs"
    role="status"
    aria-label="正在发言"
  >
    <span class="animate-pulse">▂▆▃</span>
    发言中
  </span>
</template>
<script setup lang="ts">
import { ref, watch, onBeforeUnmount, toRaw } from 'vue';
import { getSpeakingContext, isVoiceActive } from '@/services/speakingDetector';
const props = defineProps<{ stream?: MediaStream | null; muted?: boolean }>();
const speaking = ref(false);
let dispose = () => {};
watch(
  [() => props.stream, () => props.muted],
  ([stream, muted]) => {
    dispose();
    speaking.value = false;
    if (!stream || muted || !stream.getAudioTracks().length || typeof AudioContext === 'undefined')
      return;
    try {
      const context = getSpeakingContext();
      const source = context.createMediaStreamSource(toRaw(stream));
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const silent = context.createGain();
      silent.gain.value = 0;
      analyser.connect(silent);
      silent.connect(context.destination);
      const samples = new Uint8Array(analyser.fftSize);
      let lastVoice = 0;
      const resume = () => {
        void context.resume().catch(() => {});
      };
      resume();
      window.addEventListener('pointerdown', resume);
      const timer = setInterval(() => {
        const live = stream
          .getAudioTracks()
          .some((track) => track.enabled && !track.muted && track.readyState === 'live');
        if (!live) {
          speaking.value = false;
          return;
        }
        analyser.getByteTimeDomainData(samples);
        if (isVoiceActive(samples)) lastVoice = Date.now();
        speaking.value = Date.now() - lastVoice < 300;
      }, 80);
      dispose = () => {
        clearInterval(timer);
        window.removeEventListener('pointerdown', resume);
        source.disconnect();
        analyser.disconnect();
        silent.disconnect();
      };
    } catch {
      /* 无音频分析支持时保持名称可见 */
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => dispose());
</script>

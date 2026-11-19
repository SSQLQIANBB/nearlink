<script setup lang="ts">
import { computed } from 'vue';
import loadingImage from '@/assets/meeting/recording-loading.gif';

const props = defineProps<{ kind: 'transcript' | 'summary' | 'summary-waiting' }>();
const titles = {
  transcript: '正在根据完整录音生成转写',
  summary: '正在生成 AI 纪要',
  'summary-waiting': '转写完成后将自动生成 AI 纪要',
};
const messages = {
  transcript: ['读取完整录音', '识别语音内容', '校准转写时间', '整理转写分段', '生成转写文本'],
  summary: ['理解上下文意图', '捕捉容易忽略的细节', '深入分析会议内容', '建立内容之间的联系', '提炼核心要点'],
};
const tips = computed(() => {
  const steps = props.kind === 'summary' ? messages.summary : messages.transcript;
  return [...steps, ...steps, ...steps];
});
</script>

<template>
  <div class="meeting-generation-loading" role="status">
    <div class="loading-art" aria-hidden="true">
      <img :src="loadingImage" alt="" width="80" height="80" />
    </div>
    <p class="loading-title">{{ titles[kind] }}</p>
    <div class="loading-tips" aria-hidden="true">
      <ul class="tip-track">
        <li v-for="(tip, index) in tips" :key="index" :style="{ '--tip-angle': `${(5.5 - index) * 17}deg` }">
          <span class="tip-icon">✦</span><span>{{ tip }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.meeting-generation-loading {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 8px;
  min-width: 0;
}
.loading-art { display: grid; place-items: center; width: 80px; }
.loading-title { margin: 8px 0 0; color: #24292b; font-size: 16px; font-weight: 600; text-align: center; }
.loading-tips {
  width: 100%;
  height: 100px;
  margin-top: 8px;
  overflow: hidden;
  perspective: 1200px;
  mask-image: linear-gradient(transparent, #000 50%, transparent);
}
.tip-track { position: relative; height: 100%; margin: 0; padding: 0; list-style: none; transform-style: preserve-3d; animation: meeting-tips-scroll 9s linear infinite; }
.tip-track li {
  position: absolute;
  inset: calc(50% - 13px) 0 auto;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  backface-visibility: hidden;
  transform: rotateX(var(--tip-angle)) translateZ(80px);
  color: #505455;
  font-size: 12px;
  text-align: center;
}
.tip-icon { color: #137fff; }
@keyframes meeting-tips-scroll { to { transform: rotateX(85deg); } }
@media (prefers-reduced-motion: reduce) {
  .loading-art img { display: none; }
  .loading-art { height: 80px; }
  .loading-art::before { content: '✦'; color: #137fff; font-size: 42px; }
  .tip-track { animation: none; }
}
</style>

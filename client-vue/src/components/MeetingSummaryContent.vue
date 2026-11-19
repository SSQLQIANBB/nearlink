<script setup lang="ts">
import { computed } from 'vue';
import MarkdownIt from 'markdown-it';
import { NEmpty } from 'naive-ui';
import MeetingGenerationLoading from './MeetingGenerationLoading.vue';
import MeetingRegenerateButton from './MeetingRegenerateButton.vue';

const props = defineProps<{
  summary: string;
  keyPoints: string[];
  loading: boolean;
  waitingForTranscript: boolean;
  canRegenerate: boolean;
  regenerateDisabled: boolean;
}>();
const emit = defineEmits<{ regenerate: [] }>();
// AI 纪要只渲染 Markdown，禁止原始 HTML 和自动加载外部图片。
const markdown = new MarkdownIt({ html: false, linkify: false }).disable('image');
const renderedSummary = computed(() => markdown.render(props.summary));
</script>

<template>
  <section class="meeting-summary-module" aria-label="AI 纪要" :aria-busy="loading || waitingForTranscript">
    <MeetingGenerationLoading v-if="loading" kind="summary" />
    <MeetingGenerationLoading v-else-if="waitingForTranscript && !summary && !keyPoints.length" kind="summary-waiting" />
    <template v-else>
      <p v-if="waitingForTranscript" class="text-sm text-gray-500" role="status">转写完成后将更新纪要</p>
      <div v-else-if="canRegenerate" class="module-action">
        <MeetingRegenerateButton label="重新生成 AI 纪要" :disabled="regenerateDisabled" @regenerate="emit('regenerate')" />
      </div>
      <article v-if="summary" class="meeting-summary" aria-label="AI 纪要正文" v-html="renderedSummary"></article>
      <div v-if="keyPoints.length" class="keypoints-section">
        <h3>核心要点</h3>
        <ul><li v-for="(point, index) in keyPoints" :key="index">{{ point }}</li></ul>
      </div>
      <div v-if="!summary && !keyPoints.length" class="module-empty">
        <NEmpty description="暂无 AI 纪要" />
      </div>
    </template>
  </section>
</template>

<style scoped>
.meeting-summary-module { position: relative; display: flex; flex: 1; flex-direction: column; min-width: 0; }
.module-action { position: absolute; inset-inline-end: 0; inset-block-end: calc(100% + var(--detail-gap) + 3px); }
.module-empty { display: grid; flex: 1; min-height: 100px; place-items: center; }
.keypoints-section { margin-top: 16px; color: #334155; font-size: 14px; }
.keypoints-section h3 { margin-bottom: 8px; font-weight: 600; }
.keypoints-section ul { padding-inline-start: 20px; list-style: disc; line-height: 2; }
.meeting-summary {
  min-width: 0;
  overflow-x: auto;
  color: #334155;
  font-size: 14px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.meeting-summary :deep(:is(h1, h2, h3, h4, h5, h6)) {
  margin: 16px 0 6px;
  color: #172537;
  font-weight: 600;
  line-height: 1.4;
}
.meeting-summary :deep(h1) { font-size: 17px; }
.meeting-summary :deep(h2) { font-size: 15px; }
.meeting-summary > :deep(:first-child) { margin-block-start: 0; }
.meeting-summary :deep(p) { margin: 6px 0; }
.meeting-summary :deep(:is(ul, ol)) { margin: 6px 0; padding-inline-start: 1.5em; }
.meeting-summary :deep(ul) { list-style: disc outside; }
.meeting-summary :deep(ol) { list-style: decimal outside; }
.meeting-summary :deep(li + li) { margin-block-start: 4px; }
.meeting-summary :deep(hr) { margin: 16px 0; border: 0; border-top: 1px solid #e2e8f0; }
.meeting-summary :deep(blockquote) {
  margin: 12px 0;
  padding: 6px 12px;
  border-inline-start: 3px solid #93b9ed;
  background: #f3f7fc;
  color: #475569;
}
.meeting-summary :deep(code) { padding: 1px 4px; border-radius: 4px; background: #f1f5f9; }
.meeting-summary :deep(pre) {
  overflow-x: auto;
  margin: 10px 0;
  padding: 10px 12px;
  border-radius: 6px;
  background: #f1f5f9;
}
.meeting-summary :deep(pre code) { padding: 0; }
.meeting-summary :deep(table) { margin: 10px 0; border-collapse: collapse; }
.meeting-summary :deep(:is(th, td)) { padding: 6px 10px; border: 1px solid #e2e8f0; }
.meeting-summary :deep(th) { background: #f3f7fc; text-align: start; }
.meeting-summary :deep(a) { color: #1765bf; text-decoration: underline; }
</style>

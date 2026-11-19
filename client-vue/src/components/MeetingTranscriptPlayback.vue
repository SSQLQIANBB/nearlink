<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { MeetingTranscriptItem, MeetingTranscriptWord } from '@/api/meeting';
import MeetingGenerationLoading from './MeetingGenerationLoading.vue';
import MeetingRegenerateButton from './MeetingRegenerateButton.vue';

const props = defineProps<{
  segments: MeetingTranscriptItem[];
  transcript: string;
  positionMs: number | null;
  seekable: boolean;
  loading: boolean;
  regenerating: boolean;
  canRegenerate: boolean;
  regenerateDisabled: boolean;
}>();
const emit = defineEmits<{ seek: [startMs: number]; follow: [target: Element]; regenerate: [] }>();
const transcriptEl = ref<HTMLElement | null>(null);

type TextPart = { text: string; timing?: MeetingTranscriptWord };

function splitTimedText(text: string, words?: MeetingTranscriptWord[]): TextPart[] {
  if (!Array.isArray(words)) return [];
  const parts: TextPart[] = [];
  let cursor = 0;
  for (const word of words) {
    if (!word || typeof word.text !== 'string' || !word.text.trim()
      || !Number.isFinite(word.startMs) || !Number.isFinite(word.endMs)
      || word.startMs < 0 || word.endMs <= word.startMs) continue;
    const index = text.indexOf(word.text, cursor);
    if (index < 0) continue;
    if (index > cursor) parts.push({ text: text.slice(cursor, index) });
    parts.push({ text: word.text, timing: word });
    cursor = index + word.text.length;
  }
  if (cursor && cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts;
}

const rows = computed(() => {
  const segments = Array.isArray(props.segments)
    ? props.segments.filter((item) => item && typeof item.text === 'string' && item.text.trim())
    : [];
  if (!segments.length) {
    return props.transcript.split('\n').map((line) => line.trim()).filter(Boolean)
      .map((text, key) => ({ key, text, startMs: null, endMs: null, speakerId: null, parts: [] as TextPart[] }));
  }
  return segments.map((item, index) => ({
    key: item.segmentId ?? index,
    text: item.text,
    startMs: Number.isFinite(item.startMs) && item.startMs >= 0 ? item.startMs : null,
    endMs: item.endMs,
    speakerId: typeof item.speakerId === 'string' ? item.speakerId : null,
    parts: splitTimedText(item.text, item.words),
  }));
});

const speakers = computed(() => [...new Set(rows.value.map((row) => row.speakerId))].filter((id) => id !== null));
const activeRow = computed(() => {
  const position = props.positionMs;
  if (!props.seekable || position === null) return -1;
  return rows.value.findIndex((row, index) => {
    if (row.startMs === null || position < row.startMs) return false;
    const end = row.endMs ?? rows.value[index + 1]?.startMs ?? Infinity;
    return position < end;
  });
});
const activePart = computed(() => {
  const position = props.positionMs;
  return position === null ? -1 : rows.value[activeRow.value]?.parts.findIndex(({ timing }) =>
    timing && position >= timing.startMs && position < timing.endMs,
  ) ?? -1;
});

watch([transcriptEl, activeRow, activePart], ([area, rowIndex]) => {
  if (!area || rowIndex < 0) return;
  const row = area.children[rowIndex];
  if (!row) return;
  emit('follow', row.querySelector('[aria-current="true"]') ?? row);
}, { flush: 'post' });

function formatTimestamp(ms: number) {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  const minutes = pad(Math.floor(seconds / 60) % 60);
  return `${hours ? `${pad(hours)}:` : ''}${minutes}:${pad(seconds % 60)}`;
}
</script>

<template>
  <section class="detail-transcript-module" aria-label="会议转写" :aria-busy="loading">
    <MeetingGenerationLoading v-if="loading && (regenerating || !rows.length)" kind="transcript" />
    <template v-else>
      <p v-if="loading" class="text-sm text-gray-500" role="status">正在根据完整录音更新转写</p>
      <div v-else-if="canRegenerate" class="module-action">
        <MeetingRegenerateButton label="重新生成转写" :disabled="regenerateDisabled" @regenerate="emit('regenerate')" />
      </div>
      <div v-if="rows.length" ref="transcriptEl" class="detail-transcript">
        <div v-for="(row, rowIndex) in rows" :key="row.key" class="detail-transcript-item">
          <div class="detail-transcript-head">
            <span class="speaker-badge">
              <span class="wave-mark" aria-hidden="true"><span></span><span></span><span></span><span></span></span>
              {{ row.speakerId === null ? '未区分发言人' : `发言人${speakers.indexOf(row.speakerId) + 1}` }}
            </span>
            <span v-if="row.startMs !== null" class="detail-transcript-time">{{ formatTimestamp(row.startMs) }}</span>
          </div>
          <div class="detail-transcript-text">
            <template v-if="seekable && row.parts.length">
              <template v-for="(part, partIndex) in row.parts" :key="partIndex">
                <button
                  v-if="part.timing"
                  type="button"
                  class="timed-text"
                  :aria-current="rowIndex === activeRow && partIndex === activePart ? 'true' : undefined"
                  @click="emit('seek', part.timing.startMs)"
                >{{ part.text }}</button>
                <span v-else>{{ part.text }}</span>
              </template>
            </template>
            <button
              v-else-if="seekable && row.startMs !== null"
              type="button"
              class="timed-text"
              :aria-current="rowIndex === activeRow ? 'true' : undefined"
              @click="emit('seek', row.startMs)"
            >{{ row.text }}</button>
            <template v-else>{{ row.text }}</template>
          </div>
        </div>
      </div>
      <p v-else class="text-sm opacity-50">暂无转写内容</p>
    </template>
  </section>
</template>

<style scoped>
.detail-transcript-module { position: relative; display: flex; flex: 1; flex-direction: column; min-width: 0; }
.module-action { position: absolute; inset-inline-end: 0; inset-block-end: calc(100% + var(--detail-gap) + 3px); }
.detail-transcript {
  padding: 2px 4px;
}
.detail-transcript-item { padding: 12px 0; }
.detail-transcript-item + .detail-transcript-item { border-top: 1px solid #f5f6f8; }
.detail-transcript-head { display: flex; align-items: center; }
.speaker-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.5;
  background: #e7f2ff;
  color: #137fff;
}
.wave-mark { display: inline-flex; align-items: center; gap: 2px; }
.wave-mark span { width: 2px; border-radius: 1px; background: currentColor; }
.wave-mark span:nth-child(1) { height: 4px; }
.wave-mark span:nth-child(2) { height: 7px; }
.wave-mark span:nth-child(3) { height: 12px; }
.wave-mark span:nth-child(4) { height: 6px; }
.detail-transcript-time { margin-left: 8px; font-size: 12px; color: #919495; }
.detail-transcript-text { margin-top: 8px; font-size: 14px; line-height: 1.55; color: #24292b; overflow-wrap: anywhere; white-space: pre-wrap; }
.timed-text { font: inherit; text-align: left; border-radius: 3px; cursor: pointer; }
.timed-text:hover,
.timed-text[aria-current='true'] { background: #dbeafe; color: #1e40af; }
.timed-text:focus-visible { outline: 2px solid #137fff; outline-offset: 1px; }
</style>

<script setup lang="ts">
/**
 * 实时转写面板（嵌入通话/群组页面右侧区域）。
 *
 * 数据来自全局会议录音 store：打开开关后由页面调用 store.start()，
 * 本组件只负责展示实时转写与说话人（当前为 ASR 声纹聚类标签，
 * 预留 speakerResolver 映射接口，后续接入按成员采集后可显示真实昵称）。
 *
 * 样式与会议录音页（meetingMinutes.vue）的转写区一致。
 */
import { computed, nextTick, ref, watch } from 'vue';
import { NScrollbar, NSpin } from 'naive-ui';
import { useMeetingMinutesStore } from '@/stores/meetingMinutes';
import { PHASE } from '@/services/meetingMinutes';

const store = useMeetingMinutesStore();

/**
 * 说话人展示名：通过 store.resolveSpeakerName 解析。
 * 通话/群组场景在开始录音前调用 store.setSpeakerResolver 注入
 * (speakerId) => 真实昵称 的映射；未注入时按“发言人 N”展示。
 */
function speakerName(speakerId: string | null) {
  return store.resolveSpeakerName(speakerId);
}

function speakerColorIndex(speakerId: string | null) {
  if (!speakerId) return 0;
  let hash = 0;
  for (let i = 0; i < speakerId.length; i++) hash = (hash * 31 + speakerId.charCodeAt(i)) >>> 0;
  return hash % 8;
}

const transcriptScrollbar = ref<InstanceType<typeof NScrollbar> | null>(null);
const isBusy = computed(
  () =>
    store.phase === PHASE.STARTING ||
    store.phase === PHASE.RECOVERING ||
    store.phase === PHASE.STOPPING,
);

function formatTimestamp(ms: number) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// 新句子到达时跟随滚动到底部。
watch(
  () => store.transcriptList,
  async () => {
    await nextTick();
    transcriptScrollbar.value?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: 'auto' });
  },
);
</script>

<template>
  <div class="live-transcript-panel flex flex-col h-full min-h-0">
    <div class="panel-head">
      <span class="panel-title">实时转写</span>
      <NSpin v-if="isBusy" size="small" />
      <span v-else class="panel-count">已识别 {{ store.transcriptList.filter((e) => e.isFinal).length }} 句</span>
    </div>

    <NScrollbar class="panel-scroll flex-1 min-h-0" ref="transcriptScrollbar">
      <div class="panel-body">
        <div v-if="store.transcriptList.length === 0" class="panel-empty">
          <span v-if="isBusy">正在连接转写服务…</span>
          <span v-else>尚未识别到语音</span>
        </div>
        <div
          v-for="entry in store.transcriptList"
          :key="entry.segmentId"
          class="transcript-item"
        >
          <div class="item-head">
            <span class="speaker-badge" :class="`speaker-${speakerColorIndex(entry.speakerId)}`">
              <span class="wave-mark"><span></span><span></span><span></span><span></span></span>
              {{ speakerName(entry.speakerId) }}
            </span>
            <span class="item-time">{{ formatTimestamp(entry.startMs) }}</span>
          </div>
          <div class="item-text" :class="{ 'is-pending': !entry.isFinal }">{{ entry.content }}</div>
        </div>
      </div>
    </NScrollbar>
  </div>
</template>

<style scoped>
.live-transcript-panel {
  background: #fff;
  border-radius: 12px;
  overflow: hidden;
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid #f0f1f5;
}
.panel-title {
  font-size: 13px;
  font-weight: 600;
  color: #24292b;
}
.panel-count {
  font-size: 12px;
  color: #919495;
}
.panel-body {
  padding: 4px 16px 16px;
}
.panel-empty {
  padding: 40px 0;
  text-align: center;
  color: #9a9d9f;
  font-size: 13px;
}
.transcript-item {
  padding: 12px 0;
}
.transcript-item + .transcript-item {
  border-top: 1px solid #f5f6f8;
}
.item-head {
  display: flex;
  align-items: center;
}
.speaker-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.5;
}
.wave-mark {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.wave-mark span {
  width: 2px;
  border-radius: 1px;
  background: currentColor;
}
.wave-mark span:nth-child(1) { height: 4px; }
.wave-mark span:nth-child(2) { height: 7px; }
.wave-mark span:nth-child(3) { height: 12px; }
.wave-mark span:nth-child(4) { height: 6px; }

.speaker-0 { background: #e7f2ff; color: #137fff; }
.speaker-1 { background: #f7fff1; color: #26ac53; }
.speaker-2 { background: #fffbf0; color: #f2a242; }
.speaker-3 { background: #e6e6ff; color: #9a9aff; }
.speaker-4 { background: #ffecf2; color: #ff8cb0; }
.speaker-5 { background: #f8ffe6; color: #bcde6d; }
.speaker-6 { background: #ffeeff; color: #ef6bec; }
.speaker-7 { background: #e5fffe; color: #48c2be; }

.item-time {
  margin-left: 8px;
  font-size: 12px;
  color: #919495;
}
.item-text {
  margin-top: 8px;
  font-size: 14px;
  line-height: 1.55;
  color: #24292b;
  word-break: break-word;
}
.item-text.is-pending {
  color: #919495;
}
</style>

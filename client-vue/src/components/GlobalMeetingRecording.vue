<script setup lang="ts">
/**
 * 全局会议录音悬浮窗。
 *
 * 录音进行中（任意 phase 非 idle/ended）且不在会议录音页时显示；
 * 跳转其他页面时录音与转写继续（manager 由全局 pinia store 持有）。
 * 功能与样式对齐参考实现 RecordingFloatWindow：
 * 可拖拽、录音动效标识 + 计时 + 暂停/继续 + 结束 + 展开回录音页。
 */
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NButton, NModal, NSpin, useMessage } from 'naive-ui';
import { useMeetingMinutesStore } from '@/stores/meetingMinutes';
import { PHASE } from '@/services/meetingMinutes';

const route = useRoute();
const router = useRouter();
const message = useMessage();
const store = useMeetingMinutesStore();

const panelRef = ref<HTMLElement | null>(null);
const dragging = ref(false);
const confirmVisible = ref(false);
let dragPointer: number | null = null;
let dragStart = { x: 0, y: 0 };
let startTop = 0;
let startLeft = 0;

const recordingPanelVisible = computed(() =>
  route.name === 'MeetingMinutes' || (route.name === 'Meetings' && route.query.recording === '1'),
);
const visible = computed(() => store.source === 'offline' && store.isActive && !recordingPanelVisible.value);
const isPaused = computed(() => store.phase === PHASE.PAUSED);
const canToggle = computed(() => store.isRecording || isPaused.value);
const isStopping = computed(() => store.phase === PHASE.STOPPING);
const needsEndRetry = computed(() => store.phase === PHASE.END_UNCONFIRMED);
const canEnd = computed(() => canToggle.value || needsEndRetry.value);
watch(visible, (show) => {
  if (!show) confirmVisible.value = false;
});

function formatSeconds(total: number) {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function onPointerDown(event: PointerEvent) {
  if (event.button !== 0 || dragPointer !== null || (event.target as Element).closest('button')) return;
  const panel = panelRef.value;
  if (!panel) return;
  const rect = panel.getBoundingClientRect();
  dragStart = { x: event.clientX, y: event.clientY };
  startTop = rect.top;
  startLeft = rect.left;
  dragging.value = false;
  dragPointer = event.pointerId;
  panel.setPointerCapture(event.pointerId);
}

function onPointerMove(event: PointerEvent) {
  if (event.pointerId !== dragPointer) return;
  const dx = event.clientX - dragStart.x;
  const dy = event.clientY - dragStart.y;
  if (!dragging.value && Math.hypot(dx, dy) < 4) return;
  dragging.value = true;
  const panel = panelRef.value;
  if (!panel) return;
  const width = panel.offsetWidth;
  const left = Math.max(8, Math.min(startLeft + dx, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(startTop + dy, window.innerHeight - panel.offsetHeight - 8));
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  panel.style.right = 'auto';
}

function onPointerEnd(event: PointerEvent) {
  if (event.pointerId !== dragPointer) return;
  dragPointer = null;
  dragging.value = false;
}

function togglePause() {
  if (!canToggle.value) return;
  void (isPaused.value ? store.resume() : store.pause());
}

async function confirmEnd() {
  if (!canEnd.value) return;
  const result = await store.stop();
  if (!result || result.phase !== PHASE.ENDED || !result.sessionId) {
    if (store.issue) message.error(store.issue.message);
    return;
  }
  confirmVisible.value = false;
  if (store.issue) {
    message.warning(store.issue.message);
  } else {
    message.success('录音已结束');
  }
  await router.push({ name: 'Meetings', query: { sessionId: result.sessionId } });
}

/** 展开会议列表中的录音面板。 */
function expand() {
  if (recordingPanelVisible.value) return;
  if (route.name === 'Meetings') {
    void router.replace({ name: 'Meetings', query: { ...route.query, recording: '1' } });
  } else {
    void router.push({ name: 'Meetings', query: { recording: '1' } });
  }
}

</script>

<template>
  <div
    v-show="visible"
    ref="panelRef"
    class="recording-float-panel"
    :class="{ dragging }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerEnd"
    @pointercancel="onPointerEnd"
    @lostpointercapture="onPointerEnd"
  >
    <!-- 录音动效标识（暂停时静止） -->
    <div class="recording-flag" :class="{ 'is-animated': store.isRecording }" aria-hidden="true">
      <span></span><span></span><span></span><span></span><span></span>
    </div>

    <!-- 录音时长 -->
    <div class="recording-time">{{ formatSeconds(store.seconds) }}</div>

    <!-- 暂停 / 继续 -->
    <button
      type="button"
      class="float-btn float-pause"
      :disabled="!canToggle"
      :title="isPaused ? '继续' : '暂停'"
      :aria-label="isPaused ? '继续录音' : '暂停录音'"
      @click="togglePause"
    >
      <NSpin v-if="store.phase === PHASE.RECOVERING || store.phase === PHASE.STARTING" size="small" />
      <span v-else-if="isPaused" class="play-tri"></span>
      <span v-else class="pause-bars"></span>
    </button>

    <!-- 结束 -->
    <NButton
      type="error"
      size="small"
      class="float-end"
      :loading="isStopping"
      :disabled="!canEnd"
      :aria-busy="isStopping"
      :aria-label="isStopping ? '正在结束录音' : undefined"
      @click="confirmVisible = true"
    >
      <template v-if="!isStopping">{{ needsEndRetry ? '重试' : '结束' }}</template>
    </NButton>

    <span class="float-divider"></span>

    <!-- 展开回录音页 -->
    <button type="button" class="float-expand" title="展开" aria-label="展开录音页" @click="expand">
      <i class="iconfont icon-fullscreen" aria-hidden="true"></i>
    </button>
  </div>
  <NModal
    v-model:show="confirmVisible"
    preset="dialog"
    title="确认结束会议记录吗？"
    :style="{ width: '320px', maxWidth: 'calc(100vw - 32px)' }"
    :mask-closable="false"
    :close-on-esc="!isStopping"
    :closable="!isStopping"
  >
    {{ needsEndRetry ? '上次结束未确认，确定要重试吗？' : '确定要结束并保存本次会议记录吗？' }}
    <template #action>
      <NButton :disabled="isStopping" @click="confirmVisible = false">取消</NButton>
      <NButton type="error" :loading="isStopping" :disabled="!canEnd" @click="confirmEnd">结束</NButton>
    </template>
  </NModal>
</template>

<style scoped>
.recording-float-panel {
  position: fixed;
  top: 58px;
  right: 10px;
  z-index: 9999;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 12px;
  background: #fff;
  box-shadow:
    0 0 5px rgba(0, 0, 0, 0.2),
    0 4px 16px rgba(0, 0, 0, 0.08);
  cursor: move;
  user-select: none;
  touch-action: none;
}
.recording-float-panel.dragging {
  cursor: grabbing;
  box-shadow:
    0 0 5px rgba(0, 0, 0, 0.25),
    0 8px 24px rgba(0, 0, 0, 0.16);
}

/* 录音动效标识（对齐 RecordingFlag） */
.recording-flag {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  height: 16px;
}
.recording-flag span {
  width: 2px;
  background: #1172e6;
  border-radius: 1px;
  height: 4px;
  transform-origin: center;
}
.recording-flag span:nth-child(2) { height: 8px; }
.recording-flag span:nth-child(3) { height: 6px; }

.recording-flag.is-animated span {
  animation: recording-wave 0.9s ease-in-out infinite;
}
.recording-flag.is-animated span:nth-child(1) { height: 6px; animation-delay: 0s; }
.recording-flag.is-animated span:nth-child(2) { height: 12px; animation-delay: 0.12s; }
.recording-flag.is-animated span:nth-child(3) { height: 8px; animation-delay: 0.24s; }
.recording-flag.is-animated span:nth-child(4) { height: 14px; animation-delay: 0.36s; }
.recording-flag.is-animated span:nth-child(5) { height: 7px; animation-delay: 0.48s; }

@keyframes recording-wave {
  0%, 100% { transform: scaleY(0.45); opacity: 0.72; }
  50% { transform: scaleY(1); opacity: 1; }
}

.recording-time {
  font-family: 'DIN Alternate', 'Segoe UI', monospace;
  font-weight: 700;
  font-size: 16px;
  line-height: 22px;
  color: #24292b;
  font-variant-numeric: tabular-nums;
}

.float-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 28px;
  border: 0;
  border-radius: 8px;
  background: #f2f2f6;
  cursor: pointer;
  transition: background 0.15s ease;
}
.float-btn:hover:not(:disabled) { background: #e8e8ee; }
.float-btn:disabled { cursor: not-allowed; opacity: 0.6; }

.pause-bars {
  position: relative;
  width: 14px;
  height: 12px;
  display: block;
}
.pause-bars::before,
.pause-bars::after {
  content: '';
  position: absolute;
  top: 0;
  width: 3px;
  height: 12px;
  border-radius: 2px;
  background: #505455;
}
.pause-bars::before { left: 1px; }
.pause-bars::after { right: 1px; }

.play-tri {
  width: 0;
  height: 0;
  margin-left: 3px;
  border-top: 6px solid transparent;
  border-bottom: 6px solid transparent;
  border-left: 10px solid #505455;
}

.float-end {
  width: 48px;
  height: 28px;
  border-radius: 8px;
}

.float-divider {
  height: 15px;
  width: 1px;
  background: #bdbfbf;
}

.float-expand {
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  color: #24292b;
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
}
.float-expand:hover { color: #137fff; }
.float-expand:active { color: #0f63cc; }
.float-expand .iconfont {
  font-size: 14px;
  line-height: 1;
}

@media (prefers-reduced-motion: reduce) {
  .recording-flag.is-animated span { animation: none; }
}
</style>

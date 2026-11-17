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

const isMeetingMinutesRoute = computed(() => route.name === 'MeetingMinutes');
const visible = computed(() => store.isActive && !isMeetingMinutesRoute.value);
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
  if (!result || result.phase !== PHASE.ENDED) {
    if (store.issue) message.error(store.issue.message);
    return;
  }
  confirmVisible.value = false;
  if (store.issue?.type === 'TRANSCRIPT_INCOMPLETE' || store.issue?.type === 'UNSENT_AUDIO') {
    message.warning(store.issue.message);
  } else {
    message.success('录音已结束');
  }
  expand();
}

/** 展开回到会议录音页。 */
function expand() {
  if (isMeetingMinutesRoute.value) return;
  void router.push({ name: 'MeetingMinutes' });
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
      @click="confirmVisible = true"
    >
      {{ needsEndRetry ? '重试' : '结束' }}
    </NButton>

    <span class="float-divider"></span>

    <!-- 展开回录音页 -->
    <button type="button" class="float-expand" title="展开" aria-label="展开录音页" @click="expand">
      <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
        <path d="M13 3a1 1 0 0 0-1-1H8.5a.5.5 0 0 0 0 1H11.3l-3.15 3.15a.5.5 0 1 0 .7.7L12 3.7V8a.5.5 0 0 0 1 0V3zM5 6.85 8.15 3.7H5a.5.5 0 0 0 0 1H6.7L3.55 7.85a.5.5 0 1 0 .7.7L7.4 5.7 5 6.85z" opacity="0" />
        <path d="M2 2h5v1H3.4L6.2 4.8a.5.5 0 1 1-.7.7L2.7 3.4V7H1.5V2H2zm12 0v5h-1.5V3.4l-2.8 2.1a.5.5 0 1 1-.7-.7l2.8-2.1H9V2h5zM3.4 12.6l2.8-2.1a.5.5 0 0 1 .7.7l-2.8 2.1H7V14H2v-5h1.4v3.6zm10.2 0V9H15v5h-5v-1.4h3.6z" />
      </svg>
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

@media (prefers-reduced-motion: reduce) {
  .recording-flag.is-animated span { animation: none; }
}
</style>

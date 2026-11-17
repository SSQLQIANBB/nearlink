<script setup lang="ts">
import { computed, ref, nextTick, watch } from 'vue';
import { useRouter } from 'vue-router';
import { NButton, NSpin, NScrollbar, useMessage } from 'naive-ui';
import { useMeetingMinutesStore } from '@/stores/meetingMinutes';
import { PHASE } from '@/services/meetingMinutes';

const router = useRouter();
const message = useMessage();
const store = useMeetingMinutesStore();

const transcriptScrollbar = ref<InstanceType<typeof NScrollbar> | null>(null);
/** 转写偏差提示条的关闭状态（每次录音会话内只提示一次）。 */
const tipsVisible = ref(true);

const phaseLabel = computed(() => {
  switch (store.phase) {
    case PHASE.IDLE:
      return '未开始';
    case PHASE.STARTING:
      return '准备中';
    case PHASE.RECORDING:
      return '录音中';
    case PHASE.PAUSED:
      return pauseReasonLabel.value || '已暂停';
    case PHASE.RECOVERING:
      return '重连中';
    case PHASE.STOPPING:
      return '结束中';
    case PHASE.END_UNCONFIRMED:
      return '待确认结束';
    case PHASE.ENDED:
      return '已结束';
    default:
      return '';
  }
});

/** 暂停原因文案：区分用户暂停、设备无声、网络背压与 ASR 故障。 */
const pauseReasonLabel = computed(() => {
  if (store.phase !== PHASE.PAUSED) return '';
  switch (store.reason) {
    case 'user':
      return '用户暂停';
    case 'silent-input':
      return '麦克风无输入信号';
    case 'send-blocked':
      return '网络背压';
    case 'asr-fault':
      return '转写服务异常';
    case 'auth-failed':
      return '登录已失效';
    case 'recovery-failed':
      return '恢复失败';
    case 'session-gone':
      return '会话已结束';
    default:
      return '已暂停';
  }
});

function formatSeconds(total: number) {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** 转写条目时间戳：MM:SS（含小时时 HH:MM:SS）。 */
function formatTimestamp(second: number) {
  const h = Math.floor(second / 3600);
  const m = Math.floor((second % 3600) / 60);
  const s = Math.floor(second % 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** 说话人展示名与配色索引：未分离时为发言人 1，其余按 speakerId 稳定哈希取色。 */
function speakerInfo(speakerId: string | null) {
  if (!speakerId) return { name: '发言人1', colorIndex: 0 };
  let hash = 0;
  for (let i = 0; i < speakerId.length; i++) hash = (hash * 31 + speakerId.charCodeAt(i)) >>> 0;
  const colorIndex = hash % 8;
  return { name: `发言人${colorIndex + 1}`, colorIndex };
}

// 转写变化时跟随滚动到底部（组件 API）。
watch(
  () => store.transcriptList,
  async () => {
    await nextTick();
    transcriptScrollbar.value?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: 'auto' });
  },
);

function handleStart() {
  tipsVisible.value = true;
  void store
    .start()
    .then((result) => {
      if (result) message.success('开始录音');
      else message.error(store.issue?.message ?? '开始录音失败');
    });
}

function handlePause() {
  void store.pause();
}
function handleResume() {
  void store.resume();
}
function handleStop() {
  void store.stop().then((result) => {
    if (result && 'phase' in result && result.phase === PHASE.ENDED) {
      if (store.issue?.type === 'TRANSCRIPT_INCOMPLETE' || store.issue?.type === 'UNSENT_AUDIO') {
        message.warning(store.issue.message);
      } else {
        message.success('录音已结束');
      }
    }
  });
}
function handleCancel() {
  void store.cancel();
}

function goBack() {
  void router.push('/remote');
}
</script>

<template>
  <div class="meeting-page h-screen flex flex-col">
    <div class="meeting-shell flex-1 overflow-hidden flex flex-col max-w-5xl mx-auto w-full p-3 sm:p-6">
      <!-- 头部 -->
      <div class="meeting-header flex flex-wrap items-center justify-between gap-3 mb-4 flex-shrink-0">
        <div>
          <h1 class="text-xl sm:text-2xl font-bold">会议录音</h1>
          <p class="mt-1 text-sm opacity-70">独立线下录音与实时转写，无需发起通话</p>
        </div>
        <div class="flex items-center gap-3">
          <span class="phase-chip" :class="`phase-${store.phase}`">{{ phaseLabel }}</span>
          <NButton secondary @click="goBack">返回</NButton>
        </div>
      </div>

      <!-- 录音卡片 -->
      <div class="recording-card mb-4 flex-shrink-0">
        <!-- 状态图标：录音中红点呼吸，其他状态静态 -->
        <div class="recording-icon" :class="{ live: store.phase === PHASE.RECORDING }">
          <span class="recording-icon-dot"></span>
        </div>

        <!-- 计时（卡片主体） -->
        <div class="recording-duration font-mono tabular-nums">{{ formatSeconds(store.seconds) }}</div>

        <!-- 波形 -->
        <div class="recording-wave">
          <span
            v-for="(h, i) in (store.waveList.length ? store.waveList : Array(58).fill(4))"
            :key="i"
            class="recording-wave-line"
            :style="{ height: `${h}px` }"
          ></span>
        </div>

        <!-- 操作按钮 -->
        <div class="recording-actions">
          <template v-if="store.phase === PHASE.IDLE || store.phase === PHASE.ENDED">
            <NButton type="primary" class="btn-start" @click="handleStart">开始录音</NButton>
          </template>
          <template v-else-if="store.phase === PHASE.RECORDING">
            <button type="button" class="round-btn round-pause" title="暂停" @click="handlePause">
              <span class="pause-bars"></span>
            </button>
            <NButton type="error" class="btn-end" @click="handleStop">结束</NButton>
          </template>
          <template v-else-if="store.phase === PHASE.PAUSED">
            <button type="button" class="round-btn round-play" title="继续" @click="handleResume">
              <span class="play-tri"></span>
            </button>
            <NButton type="error" class="btn-end" @click="handleStop">结束</NButton>
            <NButton tertiary class="btn-discard" @click="handleCancel">放弃</NButton>
          </template>
          <template v-else-if="store.phase === PHASE.END_UNCONFIRMED">
            <NButton type="error" class="btn-end" @click="handleStop">再次结束</NButton>
            <NButton tertiary class="btn-discard" @click="handleCancel">放弃</NButton>
          </template>
          <template v-else>
            <NSpin size="small" />
          </template>
        </div>
      </div>

      <!-- 状态提示 -->
      <div v-if="store.issue && store.phase !== PHASE.IDLE" class="issue-banner" :class="`issue-${store.phase === PHASE.RECORDING ? 'warning' : 'error'}`">
        <span class="issue-text">
          {{ store.issue.message }}
          <template v-if="store.issue.suggestion">：{{ store.issue.suggestion }}</template>
        </span>
        <button type="button" class="issue-close" @click="store.$patch({ issue: null })" aria-label="关闭提示">✕</button>
      </div>

      <!-- 转写区 -->
      <div class="transcript-card flex-1 overflow-hidden flex flex-col min-h-0">
        <div v-if="tipsVisible && store.isActive && store.phase !== PHASE.ENDED" class="transcript-tips">
          <span class="tips-icon">!</span>
          <span class="tips-text">实时转写过程中，会有合理的偏差。点击“结束”录制后，智能区分多发言人，并优化转写内容。</span>
          <button type="button" class="tips-close" @click="tipsVisible = false" aria-label="关闭提示">✕</button>
        </div>

        <div class="transcript-head">
          <span class="transcript-head-title">实时转写</span>
          <span class="transcript-head-count">已识别 {{ store.transcriptList.filter((e) => e.isFinal).length }} 句</span>
        </div>

        <NScrollbar class="transcript-scroll flex-1" ref="transcriptScrollbar">
          <div class="transcript-body">
            <div v-if="store.transcriptList.length === 0" class="transcript-empty">
              <div class="transcript-empty-icon">
                <span></span><span></span><span></span><span></span>
              </div>
              <span class="transcript-empty-text">尚未识别到语音</span>
            </div>
            <div
              v-for="entry in store.transcriptList"
              :key="entry.segmentId"
              class="transcript-item"
            >
              <div class="transcript-line-head">
                <span class="speaker-badge" :class="`speaker-${speakerInfo(entry.speakerId).colorIndex}`">
                  <span class="wave-mark"><span></span><span></span><span></span><span></span></span>
                  {{ speakerInfo(entry.speakerId).name }}
                </span>
                <span class="transcript-time">{{ formatTimestamp(entry.startSecond) }}</span>
              </div>
              <div class="transcript-text" :class="{ 'is-pending': !entry.isFinal }">
                {{ entry.content }}
              </div>
            </div>
          </div>
        </NScrollbar>
      </div>
    </div>
  </div>
</template>

<style scoped>
.meeting-page {
  background: #f5f7fb;
}

/* ---------- 状态标签 ---------- */
.phase-chip {
  display: inline-flex;
  align-items: center;
  padding: 3px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  background: #eef1f6;
  color: #505455;
}
.phase-recording { background: #fff1f0; color: #ff3030; }
.phase-paused { background: #fff7e6; color: #f2a242; }
.phase-recovering,
.phase-stopping,
.phase-starting,
.phase-end-unconfirmed { background: #e7f2ff; color: #137fff; }
.phase-ended { background: #f6ffed; color: #26ac53; }

/* ---------- 录音卡片 ---------- */
.recording-card {
  display: flex;
  align-items: center;
  gap: 16px;
  box-sizing: border-box;
  padding: 10px 12px;
  border-radius: 12px;
  background: #f1f5fe;
}

.recording-icon {
  position: relative;
  flex: 0 0 40px;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 4px rgba(19, 127, 255, 0.18);
  display: flex;
  align-items: center;
  justify-content: center;
}
.recording-icon-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #c8cdd6;
}
.recording-icon.live .recording-icon-dot {
  background: #ff3030;
  animation: dot-pulse 1.2s ease-in-out infinite;
}
@keyframes dot-pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.5); opacity: 0.55; }
}

.recording-duration {
  flex: 0 0 auto;
  font-size: 18px;
  font-weight: 700;
  color: #24292b;
}

.recording-wave {
  flex: 1;
  height: 32px;
  display: flex;
  align-items: center;
  gap: 3px;
  overflow: hidden;
}
.recording-wave-line {
  flex: 0 0 2px;
  width: 2px;
  min-height: 4px;
  border-radius: 2px;
  background: #1172e6;
  transition: height 80ms linear;
}

.recording-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 0 0 auto;
}
.btn-start {
  border-radius: 8px;
  font-weight: 500;
}
.btn-end {
  border-radius: 8px;
  font-weight: 500;
}
.btn-discard {
  border-radius: 8px;
}

/* 圆形暂停 / 继续按钮 */
.round-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: 0;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(36, 41, 43, 0.12);
  cursor: pointer;
  transition: background 0.15s ease;
}
.round-btn:hover { background: #e6e9f0; }
.round-btn:active { transform: scale(0.96); }

.pause-bars {
  position: relative;
  width: 12px;
  height: 12px;
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
.pause-bars::before { left: 0; }
.pause-bars::after { right: 0; }

.play-tri {
  width: 0;
  height: 0;
  margin-left: 3px;
  border-top: 6px solid transparent;
  border-bottom: 6px solid transparent;
  border-left: 10px solid #505455;
}

/* ---------- 状态提示条 ---------- */
.issue-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.5;
}
.issue-warning { background: #fff4e5; color: #7e6240; }
.issue-error { background: #fff1f0; color: #a8071a; }
.issue-text { flex: 1; }
.issue-close {
  flex: 0 0 auto;
  border: 0;
  background: transparent;
  color: inherit;
  font-size: 12px;
  cursor: pointer;
  opacity: 0.6;
  padding: 2px 4px;
}
.issue-close:hover { opacity: 1; }

/* ---------- 转写区 ---------- */
.transcript-card {
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 1px 4px rgba(36, 41, 43, 0.06);
}

.transcript-tips {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 10px 12px 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: #fff4e5;
  font-size: 12px;
  color: #7e6240;
  line-height: 1.5;
}
.tips-icon {
  flex: 0 0 16px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #f1ab86;
  color: #fff;
  font-size: 10px;
  font-style: normal;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-top: 1px;
}
.tips-text { flex: 1; }
.tips-close {
  flex: 0 0 auto;
  border: 0;
  background: transparent;
  color: #7e6240;
  font-size: 12px;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
}
.tips-close:hover { background: #f9e8d0; }

.transcript-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid #f0f1f5;
}
.transcript-head-title {
  font-size: 13px;
  font-weight: 600;
  color: #24292b;
}
.transcript-head-count {
  font-size: 12px;
  color: #919495;
}

.transcript-scroll { min-height: 0; }

.transcript-body {
  padding: 4px 16px 16px;
}

.transcript-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 48px 0;
  color: #9a9d9f;
  font-size: 13px;
}
.transcript-empty-icon {
  display: flex;
  align-items: center;
  gap: 3px;
  opacity: 0.4;
}
.transcript-empty-icon span {
  width: 3px;
  border-radius: 2px;
  background: #919495;
}
.transcript-empty-icon span:nth-child(1) { height: 8px; }
.transcript-empty-icon span:nth-child(2) { height: 14px; }
.transcript-empty-icon span:nth-child(3) { height: 6px; }
.transcript-empty-icon span:nth-child(4) { height: 11px; }

.transcript-item {
  padding: 12px 0;
}
.transcript-item + .transcript-item {
  border-top: 1px solid #f5f6f8;
}
.transcript-line-head {
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

.transcript-time {
  margin-left: 8px;
  font-size: 12px;
  color: #919495;
}

.transcript-text {
  margin-top: 8px;
  font-size: 14px;
  line-height: 1.55;
  color: #24292b;
  word-break: break-word;
}
.transcript-text.is-pending {
  color: #919495;
}
</style>

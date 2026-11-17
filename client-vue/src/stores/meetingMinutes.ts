import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import {
  RecordingManager,
  BrowserAudioRecorder,
  MeetingMinutesSocket,
  appendTranscriptSegment,
  PHASE,
  type Phase,
  type RecordingSnapshot,
  type TranscriptEntry,
  type TranscriptSegment,
} from '@/services/meetingMinutes';
import { useAuthStore } from './auth';
import { refreshAccessToken } from '@/utils/request';
import { publicEnv } from '@/config/env';

/**
 * 会议录音 store：将 RecordingManager 的状态映射给页面。
 *
 * 独立线下入口：不依赖任何通话，直接录麦克风并实时转写。
 * store 不缓存或直接操作底层 Socket；所有生命周期走 Manager。
 * 桌面端 P3 会把 BrowserAudioRecorder 换成 Rust 采集实现，store 不变。
 */
export const useMeetingMinutesStore = defineStore('meetingMinutes', () => {
  const auth = useAuthStore();

  const phase = ref<Phase>(PHASE.IDLE);
  const reason = ref('');
  const issue = ref<{ type: string; message: string; suggestion: string } | null>(null);
  const sessionId = ref('');
  const seconds = ref(0);
  const startedAt = ref(0);
  const lastAcceptedAudioIndex = ref(-1);
  const pendingChunks = ref(0);
  const inFlightChunks = ref(0);
  const volume = ref(0);
  const waveList = ref<number[]>([]);
  const transcriptList = ref<TranscriptEntry[]>([]);

  let manager: RecordingManager | null = null;
  let disposing: Promise<void> | null = null;

  const isRecording = computed(() => phase.value === PHASE.RECORDING);
  const isActive = computed(() => phase.value !== PHASE.IDLE && phase.value !== PHASE.ENDED);

  function createSocket(handlers: Parameters<ConstructorParameters<typeof RecordingManager>[0]['createSocket']>[0]): MeetingMinutesSocket {
    return new MeetingMinutesSocket({
      url: publicEnv.socketUrl || window.location.origin,
      getToken: () => auth.token,
      onTokenExpired: () => refreshAccessToken(),
      onTranscript: (message) => {
        if (message.sessionId !== sessionId.value) return;
        handleTranscript(message.segments);
      },
      onSessionError: (message) => {
        if (message.sessionId !== sessionId.value) return;
        handlers.onSessionError(message);
        if (message.error === 'ASR_FAULT') {
          issue.value = {
            type: 'SOCKET_REJECTED',
            message: '实时转写服务异常，转写已暂停',
            suggestion: '已保存的内容不受影响，可稍后在会议记录中查看',
          };
        }
      },
      // Manager 负责断线和认证失败的状态转换；store 只消费快照。
      onDisconnected: handlers.onDisconnected,
      onAuthFailure: (error) => {
        handlers.onAuthFailure(error);
        issue.value = { type: error.type, message: error.message, suggestion: error.suggestion };
      },
    });
  }

  function ensureManager(): RecordingManager {
    if (manager) return manager;
    manager = new RecordingManager({
      createAudio: (handlers) =>
        new BrowserAudioRecorder({
          onChunk: handlers.onChunk,
          onVolume: (data) => {
            volume.value = data.volume;
            waveList.value = data.waveList;
            handlers.onVolume(data);
          },
          onFault: handlers.onFault,
        }),
      createSocket: (handlers) => createSocket(handlers),
      newSocket: (handlers) => createSocket(handlers),
    });
    manager.setListeners({
      status: applySnapshot,
      issue: (error) => {
        if (error.type !== 'CANCELLED') {
          issue.value = { type: error.type, message: error.message, suggestion: error.suggestion };
        }
      },
      ended: applySnapshot,
    });
    return manager;
  }

  function applySnapshot(snapshot: RecordingSnapshot) {
    phase.value = snapshot.phase;
    reason.value = snapshot.reason;
    sessionId.value = snapshot.sessionId || sessionId.value;
    seconds.value = snapshot.seconds;
    startedAt.value = snapshot.startedAt;
    lastAcceptedAudioIndex.value = snapshot.lastAcceptedAudioIndex;
    pendingChunks.value = snapshot.pendingChunks;
    inFlightChunks.value = snapshot.inFlightChunks;
    if (snapshot.phase === PHASE.IDLE || snapshot.phase === PHASE.ENDED) {
      volume.value = 0;
      waveList.value = [];
    }
  }

  function handleTranscript(segments: TranscriptSegment[]) {
    for (const segment of segments) {
      transcriptList.value = appendTranscriptSegment(
        transcriptList.value,
        segment,
        seconds.value,
      );
    }
  }

  /** 开始录音；重复点击复用同一次 start。失败时返回 null。 */
  async function start(): Promise<RecordingSnapshot | null> {
    if (!auth.token || !auth.currentUser || auth.loggingOut || disposing) return null;
    const m = ensureManager();
    transcriptList.value = [];
    issue.value = null;
    try {
      return await m.start();
    } catch {
      return null;
    }
  }

  async function pause() {
    return manager?.pause('user') ?? false;
  }

  async function resume() {
    return manager?.resume() ?? false;
  }

  async function stop() {
    const result = await manager?.stop('user');
    if (result && result.phase === PHASE.ENDED) {
      volume.value = 0;
      waveList.value = [];
    }
    return result;
  }

  /** 本地放弃（断线后放弃恢复）：释放资源，服务端断线期限后收尾保存。 */
  async function cancel() {
    const result = await manager?.cancelReconnect();
    if (result) {
      volume.value = 0;
      waveList.value = [];
      transcriptList.value = [];
      sessionId.value = '';
    }
    return result;
  }

  /** 统一销毁出口：等待 Manager 清理后再清空引用；可重复调用。 */
  function dispose(): Promise<void> {
    if (disposing) return disposing;
    const m = manager;
    if (!m) return Promise.resolve();
    disposing = m.dispose().finally(() => {
      manager = null;
      reset();
      disposing = null;
    });
    return disposing;
  }

  function reset() {
    sessionId.value = '';
    startedAt.value = 0;
    transcriptList.value = [];
    seconds.value = 0;
    volume.value = 0;
    waveList.value = [];
    issue.value = null;
    reason.value = '';
    lastAcceptedAudioIndex.value = -1;
    pendingChunks.value = 0;
    inFlightChunks.value = 0;
    phase.value = PHASE.IDLE;
  }

  return {
    phase,
    reason,
    issue,
    sessionId,
    seconds,
    startedAt,
    lastAcceptedAudioIndex,
    pendingChunks,
    inFlightChunks,
    volume,
    waveList,
    transcriptList,
    isRecording,
    isActive,
    start,
    pause,
    resume,
    stop,
    cancel,
    dispose,
  };
});

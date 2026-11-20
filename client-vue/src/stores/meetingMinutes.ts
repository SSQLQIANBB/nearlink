import { RecordingDraftStore } from '@/services/meetingMinutes/recordingDraftStore';
import { discardMeeting, getMeeting, type MeetingTranscriptItem } from '@/api/meeting';
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
  const transcriptList = ref<TranscriptEntry[]>([]);

  const source = ref<'offline' | 'call'>('offline');
  const ownerCallId = ref('');
  let callStreams: (() => MediaStream[]) | undefined;
  // 混音没有可信成员归属，匿名标签仅在当前会话内稳定编号。
  const speakerNames = new Map<string, string>();
  function resolveSpeakerName(speakerId: string | null): string {
    if (!speakerId) return '发言人';
    if (!speakerNames.has(speakerId)) speakerNames.set(speakerId, `发言人${speakerNames.size + 1}`);
    return speakerNames.get(speakerId)!;
  }
  let pendingStart: Promise<RecordingSnapshot | null> | null = null;
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
      drafts: new RecordingDraftStore(auth.currentUser!.id),
      discardMeeting,
      context: { source: source.value, callId: ownerCallId.value || undefined },
      detectSilentInput: source.value === 'offline',
      createAudio: (handlers) =>
        new BrowserAudioRecorder({
          getStreams: callStreams,
          onChunk: handlers.onChunk,
          onVolume: (data) => {
            if (phase.value === PHASE.RECORDING) {
              volume.value = data.volume;
            }
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
    if (snapshot.phase !== PHASE.RECORDING) {
      volume.value = 0;
    }
  }

  function handleTranscript(segments: TranscriptSegment[]) {
    for (const segment of segments) {
      const entry = appendTranscriptSegment(
        transcriptList.value,
        segment,
        seconds.value,
      );

      transcriptList.value = entry;
    }
  }

  function applyFinalTranscript(session: string, segments: MeetingTranscriptItem[]) {
    if (sessionId.value !== session || phase.value !== PHASE.ENDED) return;
    transcriptList.value = [];
    speakerNames.clear();
    handleTranscript(segments.map(segment => ({ ...segment, isFinal: true })));
  }

  function start(): Promise<RecordingSnapshot | null> {
    return begin('offline');
  }

  function startCall(callId: string, getStreams: () => MediaStream[]): Promise<RecordingSnapshot | null> {
    return begin('call', callId, getStreams);
  }

  function begin(kind: 'offline' | 'call', callId = '', getStreams?: () => MediaStream[]): Promise<RecordingSnapshot | null> {
    if (pendingStart || isActive.value) {
      if (source.value === kind && ownerCallId.value === callId) return pendingStart ?? Promise.resolve(manager!.getState());
      issue.value = { type: 'INVALID_OPERATION', message: '已有其他录音进行中', suggestion: '请先结束已有录音，再开启本次会议纪要' };
      return Promise.resolve(null);
    }
    if (!auth.token || !auth.currentUser || auth.loggingOut || disposing) return Promise.resolve(null);
    const userId = auth.currentUser.id;
    source.value = kind;
    ownerCallId.value = callId;
    const task = Promise.resolve().then(async () => {
      if (manager) { await manager.dispose(); manager = null; }
      if (pendingStart !== task || disposing || auth.loggingOut || auth.currentUser?.id !== userId || !auth.token) return null;
      callStreams = getStreams;
      transcriptList.value = [];
      speakerNames.clear();
      issue.value = null;
      try { return await ensureManager().start(); } catch { return null; }
    }).finally(() => { if (pendingStart === task) pendingStart = null; });
    pendingStart = task;
    return task;
  }

  async function stopCall(callId: string) {
    if (source.value !== 'call' || ownerCallId.value !== callId) return false;
    const starting = pendingStart;
    if (starting) await starting;
    if (source.value !== 'call' || ownerCallId.value !== callId) return false;
    // 保留结束快照；不在 await 后 dispose 全局 store，避免清理另一场刚启动的录音。
    return stop();
  }

  async function restore(session: string, kind: 'offline' | 'call' = 'offline') {
    if (isActive.value || pendingStart || disposing || !auth.currentUser) return false;
    const userId = auth.currentUser.id;
    source.value = kind;
    ownerCallId.value = '';
    const task = Promise.resolve().then(async () => {
      if (manager) { await manager.dispose(); manager = null; }
      callStreams = undefined;
      try {
        const { meeting } = await getMeeting(session);
        if (pendingStart !== task || disposing || auth.loggingOut || auth.currentUser?.id !== userId) return null;
        transcriptList.value = [];
        handleTranscript(meeting.transcriptJson.map(segment => ({ ...segment, isFinal: true })));
        return await ensureManager().restore(session);
      } catch { return null; }
    }).finally(() => { if (pendingStart === task) pendingStart = null; });
    pendingStart = task;
    return !!await task;
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
    }
    return result;
  }

  async function cancel() {
    const result = await manager?.discard();
    if (result && result.reason === 'discard') {
      volume.value = 0;
      transcriptList.value = [];
      sessionId.value = '';
      return true;
    }
    return false;
  }

  async function discardDraft(draftSessionId: string) {
    const drafts = new RecordingDraftStore(auth.currentUser!.id);
    await discardMeeting(draftSessionId);
    await drafts.remove(draftSessionId).catch(error => console.warn('meeting_draft_cleanup_failed', error));
  }

  /** 统一销毁出口：等待 Manager 清理后再清空引用；可重复调用。 */
  function dispose(): Promise<void> {
    if (disposing) return disposing;
    const current = manager;
    pendingStart = null;
    // 不等待用户尚未响应的麦克风授权；Manager 立即使进行中的输入准备失效。
    disposing = Promise.resolve(current?.dispose()).finally(() => {
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
    issue.value = null;
    reason.value = '';
    lastAcceptedAudioIndex.value = -1;
    pendingChunks.value = 0;
    inFlightChunks.value = 0;
    phase.value = PHASE.IDLE;
    speakerNames.clear();
    source.value = 'offline';
    ownerCallId.value = '';
    callStreams = undefined;
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
    transcriptList,
    applyFinalTranscript,
    isRecording,
    isActive,
    start,
    pause,
    resume,
    stop,
    cancel,
    discardDraft,
    dispose,
    source,
    ownerCallId,
    startCall,
    restore,
    stopCall,
    resolveSpeakerName,
  };
});

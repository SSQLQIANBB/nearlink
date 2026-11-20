import { processMeetingAudioTasks, retryMeetingAudio } from './meetingAudioTasks';
import { publishMeetingChange } from './meetingChanges';
import { FINAL_SUMMARY_PENDING, FINAL_TRANSCRIPT_FAILED, FINAL_TRANSCRIPT_PENDING, REGENERATE_TRANSCRIPT_PENDING, transcribeMeetingWav, transcribeStoredMeetingWav } from './meetingFinalTranscript';
import { generateMeetingSummary, SummaryError } from './llmMinutesService';
import { Op } from 'sequelize';
import { stat } from 'node:fs/promises';
import { randomUUID } from 'crypto';
import type { Socket } from 'socket.io';
import {
  AuthenticatedSessionPayload,
  onLoginSessionsRevoked,
} from './loginSessionService';
import { AsrClient, type AsrSessionHandle, type AsrTranscriptSegment } from './asrClient';
import { MeetingMinutes } from '../models/MeetingMinutes';
import { parseStorageReference } from './qiniuStorageService';
import {
  MeetingAudioStore,
  meetingAudioStore,
  type MeetingAudioManifest, type MeetingAudioStatus,
} from './meetingAudioStore';

/**
 * 会议录音会话服务。
 *
 * 职责（与 Socket 配置分离）：
 * - 会话归属与生命周期状态转换（recording/paused/finalizing/ended/failed）；
 * - sessionId 由服务端创建（start 不允许携带），每次操作校验归属；
 * - 音频顺序与去重（lastAcceptedAudioIndex / acceptedSamples，按实际字节数计样本）；
 * - 音频先写暂存目录（manifest 落盘）再 ACK；ACK 即"该分片已持久化"的确认，
 *   客户端只删除已持久化确认的分片；
 * - ASR 编排（串行转发、有界发送积压、结束等待）与转写检查点持久化；
 * - 暂停与断线分别计时：手动暂停草稿保留 3 小时，普通断线恢复期 5 分钟，
 *   截止时间写入数据库 audioPausedAttachDeadline（进程重启后仍有效）；
 * - 统一收尾链路：停止采集 → 等待分片持久化 → 流式封装 WAV → 上传七牛私有空间
 *   → 更新数据库音频状态与对象引用 → 清理本地暂存；上传/落库失败保留本地文件，
 *   支持幂等重试（同一七牛对象 key）；
 * - 音频状态与转写状态独立：ASR 故障不阻止音频保存；
 * - 登录撤销终止恢复资格；启动时续传上次进程遗留的录音（封装已有分片并上传），
 *   尾片无法确认时标记 partial，处理失败时标记 failed。
 *
 * 注意：`/meeting-minutes` 是 Socket.IO 的 path，不是 namespace。
 * 协议见 docs/MEETING_RECORDING_PROTOCOL.md。
 */

export const AUDIO_FORMAT = Object.freeze({
  encoding: 'pcm_s16le' as const,
  sampleRate: 16_000 as const,
  channels: 1 as const,
});

/** 单片最大字节数：200ms × 16kHz × 2B = 6400B，放宽到 32KB 容忍异常分片。 */
const MAX_CHUNK_BYTES = 32 * 1024;
/** 单会话 ASR 发送积压上限（片），超出丢弃并标记不完整。 */
const MAX_ASR_BACKLOG = 200;
/** 普通录制断线恢复期限（毫秒）。 */
const ATTACH_DEADLINE_MS = 5 * 60 * 1000;
/** 手动暂停草稿保留期限（毫秒）：3 小时。 */
const PAUSE_DEADLINE_MS = 3 * 60 * 60 * 1000;
/** ASR 收尾等待超时（毫秒）。 */
const ASR_FINISH_TIMEOUT_MS = 30_000;

export type RecordingStatus = 'recording' | 'paused' | 'finalizing' | 'ended' | 'failed';

type ConfirmedSegment = Omit<AsrTranscriptSegment, 'isFinal'>;

export interface FinalizeResult {
  ok: boolean;
  error?: string;
  durationSeconds: number;
  transcriptComplete: boolean;
  /** 音频保存状态：让前端区分完整保存(ready)、部分保存(partial)和保存失败(failed)。 */
  audioStatus?: string;
}

interface RecordingSession {
  sessionId: string;
  userId: number;
  sid: string;
  status: RecordingStatus;
  /** 当前绑定的上传连接；null 表示处于断线恢复期限中。 */
  socket: Socket | null;
  lastAcceptedAudioIndex: number;
  acceptedSamples: number;
  /** 临时句（按 segmentId）；确认句落定后移除。 */
  transientSegments: Map<number, ConfirmedSegment>;
  /** 已确认句（内存序，落库失败时保留）。 */
  confirmedSegments: ConfirmedSegment[];
  /** 确认句串行写入链。 */
  checkpointChain: Promise<void>;
  /**
   * 持久化串行链：序号检查 → 分片落盘 → manifest 更新 → 内存确认点更新，
   * 以及暂停期限的 manifest 更新，全部纳入同一会话串行操作，避免并发丢更新。
   */
  persistChain: Promise<void>;
  asr: AsrSessionHandle | null;
  /** 会话内串行转发队列，保证 ASR 收帧顺序与去重。 */
  audioChain: Promise<unknown>;
  /** ASR 发送积压计数。 */
  asrBacklog: number;
  attachDeadline: ReturnType<typeof setTimeout> | null;
  pendingFinalize: Promise<FinalizeResult> | null;
  asrFault: boolean;
  /** 已接受的音频可能未完整识别；重建上游后也保留此标记。 */
  transcriptIncomplete: boolean;
  /** 已确认的最大 segmentId（重建 ASR 流后避免句序号覆盖旧句）。 */
  maxConfirmedSegmentId: number;
  /** 暂停/断线恢复截止时间（内存镜像；权威值在数据库 audioPausedAttachDeadline）。 */
  pausedAttachDeadline: number | null;
  /** 暂停是否用户手动触发（决定 3h 还是 5min 恢复期限）。 */
  manuallyPaused: boolean;
  /** 已收到客户端结束通知（尾片将接收完毕）；重启恢复时区分尾片完整性。 */
  clientEnded: boolean;
  /** 音频暂存进度（manifest 内存镜像；ACK 前保证已落盘）。 */
  audioManifest: MeetingAudioManifest | null;
}

type RecordingAsr = Pick<AsrClient, 'backend' | 'open'>;

export class MeetingRecordingService {
  private readonly asr: RecordingAsr;
  private readonly audioStore: MeetingAudioStore;
  private readonly sessions = new Map<string, RecordingSession>();
  private readonly pendingDiscards = new Map<string, Promise<boolean>>();
  private readonly activeByUser = new Map<number, string>();
  private readonly creatingByUser = new Map<number, Promise<RecordingSession | null>>();
  private readonly socketToSession = new Map<string, string>();
  private readonly revocableSockets = new Map<string, { userId: number; sid: string; socket: Socket }>();
  private unsubscribeRevocation: (() => void) | null = null;
  private closed = false;
  private tasksTimer: ReturnType<typeof setInterval> | null = null;
  private tasksPromise: Promise<void> | null = null;
  private finalMinutesTask: Promise<void> | null = null;
  private finalMinutesRequested = false;
  private readonly finalMinutesLifetime = new AbortController();
  /** 已完成收尾的会话结果缓存（end ACK 丢失后重复 end 可读取）。LRU 上限。 */
  private readonly savedResults = new Map<string, { userId: number; result: FinalizeResult }>();
  private static readonly MAX_SAVED_RESULTS = 200;

  constructor(options: { asr: RecordingAsr; audioStore?: MeetingAudioStore }) {
    this.asr = options.asr;
    this.audioStore = options.audioStore ?? meetingAudioStore;
  }

  /** 连接握手成功后调用；绑定用户身份并注册撤销监听。 */
  onConnect(socket: Socket, user: AuthenticatedSessionPayload): void {
    this.revocableSockets.set(socket.id, { userId: user.userId, sid: user.sid, socket });
    if (!this.unsubscribeRevocation) {
      this.unsubscribeRevocation = onLoginSessionsRevoked((event) => {
        void this.revokeUserSessions(event.userId, event.sid).catch(error => console.error('meeting_revocation_failed', error.message));
      });
    }
  }

  onDisconnect(socket: Socket): void {
    this.revocableSockets.delete(socket.id);
    const sessionId = this.socketToSession.get(socket.id);
    if (!sessionId) return;
    this.socketToSession.delete(socket.id);
    const session = this.sessions.get(sessionId);
    if (!session || session.socket !== socket) return;
    session.socket = null;
    if (this.creatingByUser.has(session.userId)) { this.closeAsr(session); return; }
    if (session.status === 'recording' || session.status === 'paused') {
      // 解绑连接，但保留会议、已确认转写与已持久化音频。
      session.status = 'paused';
      this.finishPausedTencentStream(session);
      // 普通断线：恢复期限 5 分钟；手动暂停中（含其断线）保留原 3 小时截止时间，不覆盖。
      if (!session.manuallyPaused) {
        void this.schedulePausedDeadline(session, Date.now() + ATTACH_DEADLINE_MS).catch(error => console.error('meeting_deadline_failed', error.message));
      } else if (session.attachDeadline === null) {
        // 手动暂停的截止时间定时器可能已被取消（如刚 pause），按持久化值重建。
        void this.schedulePausedDeadline(session, session.pausedAttachDeadline).catch(error => console.error('meeting_deadline_failed', error.message));
      }
    }
  }

  private async revokeUserSessions(userId: number, sid?: string): Promise<void> {
    for (const [id, connection] of this.revocableSockets) {
      if (connection.userId !== userId || (sid && connection.sid !== sid)) continue;
      this.revocableSockets.delete(id);
      connection.socket.disconnect(true);
    }
    for (const session of [...this.sessions.values()]) {
      if (session.userId !== userId) continue;
      if (sid && session.sid !== sid) continue;
      if (this.creatingByUser.has(session.userId)) {
        session.socket = null;
        this.closeAsr(session);
        continue;
      }
      // 用户主动结束、退出登录或授权撤销不能按普通网络故障恢复。
      await this.finalize(session, 'auth_revoked');
    }
  }

  // ---- 控制操作 ----------------------------------------------------------

  /** start：会话由服务端创建；音频保存不依赖转写服务是否可用。 */
  async start(
    socket: Socket,
    user: AuthenticatedSessionPayload,
    context: { source: 'offline' | 'call'; callId?: string } = { source: 'offline' },
  ): Promise<{ ok: true; sessionId: string; transcriptionAvailable: boolean } | { ok: false; error: string }> {
    if (this.closed) return { ok: false, error: 'INTERNAL' };
    if (!this.revocableSockets.has(socket.id)) return { ok: false, error: 'FORBIDDEN' };
    const activeId = this.activeByUser.get(user.userId);
    if (activeId) {
      const active = this.sessions.get(activeId);
      if (active) {
        return { ok: false, error: 'SESSION_ACTIVE' };
      }
    }
    if (this.creatingByUser.has(user.userId)) return { ok: false, error: 'SESSION_ACTIVE' };
    const creation = this.doStart(socket, user, context);
    this.creatingByUser.set(user.userId, creation);
    try {
      const session = await creation;
      return session ? { ok: true, sessionId: session.sessionId, transcriptionAvailable: !session.asrFault } : { ok: false, error: 'ASR_UNAVAILABLE' };
    } finally {
      this.creatingByUser.delete(user.userId);
    }
  }

  private async doStart(
    socket: Socket,
    user: AuthenticatedSessionPayload,
    context: { source: 'offline' | 'call'; callId?: string } = { source: 'offline' },
  ): Promise<RecordingSession | null> {
    // ASR 不可用时继续保存音频，转写标记不完整。
    const session = this.createSession(randomUUID(), user, socket);
    try {
      await this.openAsr(session, 0);
      if (!session.socket || this.closed) {
        this.teardownSession(session);
        return null;
      }
    } catch (error) {
      console.error('meeting_minutes_asr_open_failed', { sessionId: session.sessionId, type: (error as Error)?.message });
      session.asrFault = true;
      session.transcriptIncomplete = true;
      this.closeAsr(session);
    }
    if (!session.socket || this.closed || !this.revocableSockets.has(socket.id)) { this.closeAsr(session); this.teardownSession(session); return null; }
    // 音频暂存先行创建：manifest 落盘是后续 ACK 的前提；失败同样不建数据库记录。
    try {
      await this.audioStore.createSession(session.sessionId, { userId: user.userId, sid: user.sid, ...context });
      const loaded = await this.audioStore.loadManifest(session.sessionId);
      if (loaded.ok === false) throw new Error('manifest_missing');
      session.audioManifest = loaded.manifest;
    } catch (error) {
      session.asr?.close();
      this.teardownSession(session);
      console.error('meeting_minutes_audio_init_failed', { sessionId: session.sessionId, type: (error as Error)?.message });
      return null;
    }
    if (!session.socket || this.closed || !this.revocableSockets.has(socket.id)) {
      this.closeAsr(session);
      await this.audioStore.removeLocal(session.sessionId);
      this.teardownSession(session);
      return null;
    }
    try {
      await MeetingMinutes.create({
        sessionId: session.sessionId,
        userId: user.userId,
        title: '',
        source: context.source,
        status: 'recording',
        durationSeconds: 0,
        transcript: '',
        transcriptJson: '[]',
        audioStatus: 'recording',
      });
    } catch (error) {
      // 数据库创建失败：关闭已创建的 ASR 并清理音频暂存，不留悬挂资源。
      session.asr?.close();
      void this.audioStore.removeLocal(session.sessionId).catch(() => undefined);
      this.teardownSession(session);
      console.error('meeting_minutes_create_failed', { sessionId: session.sessionId, type: (error as Error)?.message });
      return null;
    }
    if (this.closed || !session.socket || !this.revocableSockets.has(socket.id)) {
      await this.finalize(session, 'start_cancelled');
      return null;
    }
    this.activeByUser.set(user.userId, session.sessionId);
    publishMeetingChange(user.userId, session.sessionId, 'metadata');
    return session;
  }

  /** attach：重连后重新绑定已有会话（校验归属与可恢复性）。 */
  async attach(
    socket: Socket,
    user: AuthenticatedSessionPayload,
    sessionId: string,
  ): Promise<
    | {
        ok: true;
        status: RecordingStatus;
        lastAcceptedAudioIndex: number;
        acceptedSamples: number;
        audioFormat: typeof AUDIO_FORMAT;
        pausedAttachDeadline: number | null;
      }
    | { ok: false; error: string }
  > {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== user.userId) return { ok: false, error: 'SESSION_NOT_FOUND' };
    // 校验登录会话 sid：同一用户不同登录会话不可抢占。
    if (user.sid && session.sid && user.sid !== session.sid) return { ok: false, error: 'FORBIDDEN' };
    if (session.status === 'ended' || session.status === 'failed' || session.status === 'finalizing') {
      return { ok: false, error: 'SESSION_NOT_FOUND' };
    }
    if (session.socket && session.socket !== socket && session.socket.connected) return { ok: false, error: 'SESSION_ACTIVE' };
    if (session.pausedAttachDeadline !== null && session.pausedAttachDeadline <= Date.now()) return { ok: false, error: 'SESSION_NOT_FOUND' };
    await session.persistChain;
    if (!this.requireOwnedSession(user, sessionId)) return { ok: false, error: 'SESSION_NOT_FOUND' };
    if (session.socket && session.socket !== socket && session.socket.connected) return { ok: false, error: 'SESSION_ACTIVE' };
    session.socket = socket;
    this.socketToSession.set(socket.id, session.sessionId);
    // 重新绑定只恢复连接，不等同于继续录音：
    // - 录制中（recording）的断线重连：清除 5min 断线期限，恢复采集；
    // - 暂停中（手动暂停/断线暂停）：保留截止时间，不自动清除，由用户 resume 才清除。
    if (session.status === 'recording') {
      await this.schedulePausedDeadline(session, null);
    } else if (session.attachDeadline === null && session.pausedAttachDeadline !== null) {
      // 暂停会话的截止定时器缺失（如重启重建），按持久化值重建到期收尾任务。
      await this.schedulePausedDeadline(session, session.pausedAttachDeadline);
    }
    return {
      ok: true,
      status: session.status,
      lastAcceptedAudioIndex: session.lastAcceptedAudioIndex,
      acceptedSamples: session.acceptedSamples,
      audioFormat: { ...AUDIO_FORMAT },
      pausedAttachDeadline: session.pausedAttachDeadline,
    };
  }

  async pause(
    socket: Socket,
    user: AuthenticatedSessionPayload,
    sessionId: string,
  ): Promise<{ ok: true; lastAcceptedAudioIndex: number; pausedAttachDeadline: number | null } | { ok: false; error: string }> {
    const session = this.requireOwnedSession(user, sessionId);
    if (!session) return { ok: false, error: 'SESSION_NOT_FOUND' };
    if (session.socket !== socket) return { ok: false, error: 'FORBIDDEN' };
    if (session.status === 'recording' || (session.status === 'paused' && !session.manuallyPaused)) {
      session.status = 'paused';
      // 手动暂停：草稿保留 3 小时；截止时间持久化，进程重启后仍有效。
      session.manuallyPaused = true;
      await this.schedulePausedDeadline(session, Date.now() + PAUSE_DEADLINE_MS);
      this.finishPausedTencentStream(session);
    }
    return { ok: true, lastAcceptedAudioIndex: session.lastAcceptedAudioIndex, pausedAttachDeadline: session.pausedAttachDeadline };
  }

  async resume(
    socket: Socket,
    user: AuthenticatedSessionPayload,
    sessionId: string,
  ): Promise<{ ok: true; lastAcceptedAudioIndex: number; pausedAttachDeadline: number | null } | { ok: false; error: string }> {
    const session = this.requireOwnedSession(user, sessionId);
    if (!session) return { ok: false, error: 'SESSION_NOT_FOUND' };
    if (session.socket !== socket) return { ok: false, error: 'FORBIDDEN' };
    // 暂停截止时间内才能继续；超时会话由期限收尾（ended/failed）后不可恢复。
    if (session.pausedAttachDeadline !== null && Date.now() >= session.pausedAttachDeadline) {
      return { ok: false, error: 'SESSION_NOT_FOUND' };
    }
    if (session.status === 'paused') {
      session.asrFault = false;
      session.status = 'recording';
      session.manuallyPaused = false;
      session.pausedAttachDeadline = null;
      this.cancelAttachDeadline(session);
      await this.persistPausedAttachDeadline(session, null);
    }
    return { ok: true, lastAcceptedAudioIndex: session.lastAcceptedAudioIndex, pausedAttachDeadline: null };
  }

  /** end：收尾屏障。重复 end 复用同一收尾 Promise；落库失败不返回成功。 */
  async end(
    socket: Socket,
    user: AuthenticatedSessionPayload,
    sessionId: string,
    lastAudioIndex: number,
    tailComplete = true,
  ): Promise<
    | { ok: true; durationSeconds: number; transcriptComplete: boolean; audioStatus?: string }
    | { ok: false; error: string }
  > {
    // end ACK 丢失后重复 end：读回已保存结果，不重新执行收尾。
    const saved = this.savedResults.get(sessionId);
    if (saved) {
      if (saved.userId !== user.userId) return { ok: false, error: 'SESSION_NOT_FOUND' };
      return {
        ok: true,
        durationSeconds: saved.result.durationSeconds,
        transcriptComplete: saved.result.transcriptComplete,
        audioStatus: saved.result.audioStatus,
      };
    }
    const session = this.sessions.get(sessionId);
    if (session) {
      if (session.userId !== user.userId) return { ok: false, error: 'SESSION_NOT_FOUND' };
      if (!Number.isSafeInteger(lastAudioIndex) || lastAudioIndex < -1) return { ok: false, error: 'BAD_REQUEST' };
      if (session.sid !== user.sid) return { ok: false, error: 'FORBIDDEN' };
      if (session.socket && session.socket !== socket && session.socket.connected) return { ok: false, error: 'SESSION_ACTIVE' };
      await session.persistChain;
      if (this.pendingDiscards.has(sessionId) || (this.sessions.get(sessionId) !== session && !this.savedResults.has(sessionId))) {
        return { ok: false, error: 'SESSION_NOT_FOUND' };
      }
      if (lastAudioIndex !== session.lastAcceptedAudioIndex) return { ok: false, error: 'AUDIO_GAP' };
      if (!session.pendingFinalize) session.clientEnded = tailComplete;
      const result = await this.finalize(session, 'ended');
      if (!result.ok) return { ok: false, error: result.error ?? 'INTERNAL' };
      return { ok: true, durationSeconds: result.durationSeconds, transcriptComplete: result.transcriptComplete, audioStatus: result.audioStatus };
    }
    // 内存会话已释放（进程重启或 LRU 淘汰）：从数据库读回已保存结果。
    const record = await MeetingMinutes.findOne({
      where: { sessionId, userId: user.userId, audioStatus: { [Op.ne]: 'deleting' } },
      attributes: ['sessionId', 'status', 'durationSeconds', 'transcriptJson', 'audioStatus'],
    });
    if (!record) return { ok: false, error: 'SESSION_NOT_FOUND' };
    if (record.status !== 'ended' && record.status !== 'failed') return { ok: false, error: 'BAD_REQUEST' };
    const transcriptComplete = record.status === 'ended';
    const result: FinalizeResult = {
      ok: true,
      durationSeconds: record.durationSeconds ?? 0,
      transcriptComplete,
      audioStatus: (record as unknown as { audioStatus: string }).audioStatus,
    };
    this.savedResults.set(sessionId, { userId: user.userId, result });
    return { ok: true, durationSeconds: result.durationSeconds, transcriptComplete, audioStatus: result.audioStatus };
  }

  discard(user: AuthenticatedSessionPayload, sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return this.markDiscarded(user.userId, sessionId);
    if (session.userId !== user.userId || (session.sid && session.sid !== user.sid)) return Promise.resolve(false);
    const pending = this.pendingDiscards.get(sessionId);
    if (pending) return pending;
    if (session.status !== 'recording' && session.status !== 'paused') return Promise.resolve(false);

    const previousStatus = session.status;
    // 先封住新分片、恢复和收尾入口，再等已排队的分片完成落盘。
    session.status = 'finalizing';
    const task = this.markDiscarded(user.userId, sessionId, session)
      .finally(async () => {
        this.pendingDiscards.delete(sessionId);
        if (session.status !== 'finalizing') return;
        session.status = session.socket ? previousStatus : 'paused';
        const deadline = session.pausedAttachDeadline ?? (session.socket ? null : Date.now() + ATTACH_DEADLINE_MS);
        if (session.attachDeadline === null && deadline !== null) {
          await this.schedulePausedDeadline(session, deadline).catch(error => console.error('meeting_deadline_failed', error.message));
        }
      });
    this.pendingDiscards.set(sessionId, task);
    return task;
  }

  private async markDiscarded(userId: number, sessionId: string, session?: RecordingSession): Promise<boolean> {
    await session?.persistChain;
    const where = { sessionId, userId };
    // deleting 由现有清理任务重试，终态也确保重启后不会恢复或上传草稿。
    const [claimed] = await MeetingMinutes.update(
      { status: 'failed', audioStatus: 'deleting', audioPausedAttachDeadline: null },
      { where: { ...where, status: { [Op.in]: ['recording', 'paused'] } } },
    );
    if (!claimed) {
      const record = await MeetingMinutes.findOne({ where, attributes: ['audioStatus'] });
      if (record && record.audioStatus !== 'deleting') return false;
    }
    if (session) {
      session.status = 'failed';
      this.teardownSession(session);
    }
    if (claimed) publishMeetingChange(userId, sessionId, 'removed');
    return true;
  }

  private requireOwnedSession(user: AuthenticatedSessionPayload, sessionId: string): RecordingSession | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== user.userId) return null;
    if (session.status === 'finalizing' || session.status === 'ended' || session.status === 'failed') return null;
    return session;
  }

  // ---- 音频 --------------------------------------------------------------

  /** 接收二进制分片；先持久化（manifest 落盘）再 ACK，按序去重并串行转发 ASR。 */
  onAudio(
    socket: Socket,
    user: AuthenticatedSessionPayload,
    sessionId: string,
    audioIndex: number,
    pcm: Buffer,
  ): Promise<{ sessionId: string; lastAcceptedAudioIndex: number; acceptedSamples: number; expectedAudioIndex?: number } | { error: string }> {
    return this.handleAudio(socket, user, sessionId, audioIndex, pcm);
  }

  private async handleAudio(
    socket: Socket,
    user: AuthenticatedSessionPayload,
    sessionId: string,
    audioIndex: number,
    pcm: Buffer,
  ): Promise<{ sessionId: string; lastAcceptedAudioIndex: number; acceptedSamples: number; expectedAudioIndex?: number } | { error: string }> {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== user.userId) return { error: 'SESSION_NOT_FOUND' };
    // 音频只接受当前绑定的上传连接。
    if (session.socket !== socket) return { error: 'FORBIDDEN' };
    if (session.status === 'finalizing' || session.status === 'ended' || session.status === 'failed') {
      return { error: 'BAD_REQUEST' };
    }
    if (!Buffer.isBuffer(pcm) || pcm.length === 0 || pcm.length > MAX_CHUNK_BYTES || pcm.length % 2 !== 0) {
      return { error: 'BAD_REQUEST' };
    }
    if (!Number.isSafeInteger(audioIndex) || audioIndex < 0) return { error: 'BAD_REQUEST' };
    type AudioAck = { sessionId: string; lastAcceptedAudioIndex: number; acceptedSamples: number; expectedAudioIndex?: number } | { error: string };
    const persist = session.persistChain.catch(() => undefined).then(async (): Promise<AudioAck> => {
      if (audioIndex > session.lastAcceptedAudioIndex + 1) return {
        sessionId, lastAcceptedAudioIndex: session.lastAcceptedAudioIndex,
        acceptedSamples: session.acceptedSamples, expectedAudioIndex: session.lastAcceptedAudioIndex + 1,
      };
      if (audioIndex <= session.lastAcceptedAudioIndex) return {
        sessionId, lastAcceptedAudioIndex: session.lastAcceptedAudioIndex, acceptedSamples: session.acceptedSamples,
      };
      try {
        const startSample = session.acceptedSamples;
        const manifest = await this.audioStore.appendChunk(sessionId, audioIndex, pcm);
        session.audioManifest = manifest;
        session.lastAcceptedAudioIndex = manifest.lastAcceptedAudioIndex;
        session.acceptedSamples = manifest.acceptedSamples;
        // ASR 背压只影响文字完整性，不能推翻已经可靠持久化的音频 ACK。
        if (!session.asrFault && session.asrBacklog < MAX_ASR_BACKLOG) {
          this.queueAsrFrame(session, pcm, startSample);
        } else session.transcriptIncomplete = true;
        return { sessionId, lastAcceptedAudioIndex: manifest.lastAcceptedAudioIndex, acceptedSamples: manifest.acceptedSamples };
      } catch (error) {
        console.error('meeting_audio_persist_failed', { sessionId, message: (error as Error).message });
        return { error: 'PERSIST_FAILED' };
      }
    });
    session.persistChain = persist.then(() => undefined);
    return persist;
  }

  private queueAsrFrame(session: RecordingSession, pcm: Buffer, startSample: number): void {
    session.asrBacklog += 1;
    session.audioChain = session.audioChain.then(async () => {
      if (session.asrFault || session.status === 'ended' || session.status === 'failed') return;
      try {
        const asr = session.asr ?? await this.openAsr(session, startSample);
        await asr.sendPcm(pcm);
      } catch (error) {
        this.invalidateAsr(session);
        session.asrFault = true;
        session.transcriptIncomplete = true;
        console.error('meeting_minutes_asr_send_failed', {
          sessionId: session.sessionId,
          type: (error as Error).message,
        });
        session.socket?.emit('minutes_error', { sessionId: session.sessionId, error: 'ASR_FAULT' });
      }
    }).finally(() => {
      session.asrBacklog -= 1;
    });
  }

  private async openAsr(session: RecordingSession, startSample: number): Promise<AsrSessionHandle> {
    const segmentOffset = session.maxConfirmedSegmentId + 1;
    const timeOffset = Math.floor((startSample / AUDIO_FORMAT.sampleRate) * 1000);
    let asr: AsrSessionHandle | undefined;
    asr = await this.asr.open({
      onSegment: (segment) => {
        if (!asr || session.asr !== asr) return;
        this.applySegment(session, {
          ...segment,
          segmentId: segmentOffset + segment.segmentId,
          startMs: timeOffset + segment.startMs,
          endMs: segment.endMs === null ? null : timeOffset + segment.endMs,
          words: segment.words?.map((word) => ({
            ...word,
            startMs: timeOffset + word.startMs,
            endMs: timeOffset + word.endMs,
          })),
        });
      },
      onFault: (error) => {
        if (!asr || session.asr !== asr) return;
        console.error('meeting_minutes_asr_fault', { sessionId: session.sessionId, type: error.message });
        this.invalidateAsr(session);
      },
    });
    if (session.status === 'failed' || session.status === 'ended') {
      asr.close();
      throw new Error('SESSION_NOT_FOUND');
    }
    session.asr = asr;
    return asr;
  }

  private invalidateAsr(session: RecordingSession): void {
    session.transcriptIncomplete = true;
    this.closeAsr(session);
  }

  private closeAsr(session: RecordingSession): void {
    const asr = session.asr;
    session.asr = null;
    asr?.close();
    for (const segment of session.transientSegments.values()) {
      session.socket?.emit('minutes_transcript', {
        sessionId: session.sessionId,
        segments: [{ ...segment, text: '', isFinal: true }],
      });
    }
    session.transientSegments.clear();
  }

  private finishPausedTencentStream(session: RecordingSession): void {
    if (this.asr.backend !== 'tencent') return;
    // 腾讯云空闲超过约 6 秒会断开。暂停时排在已接收音频之后主动收尾，
    // 恢复时由首片音频开启新流，长时间暂停不会占用上游连接。
    session.audioChain = session.audioChain.then(async () => {
      if (!(await this.finishAsr(session))) session.transcriptIncomplete = true;
      this.closeAsr(session);
    });
  }

  private createSession(sessionId: string, user: AuthenticatedSessionPayload, socket: Socket | null): RecordingSession {
    const session: RecordingSession = {
      sessionId,
      userId: user.userId,
      sid: user.sid,
      status: 'recording',
      socket,
      lastAcceptedAudioIndex: -1,
      acceptedSamples: 0,
      transientSegments: new Map(),
      confirmedSegments: [],
      checkpointChain: Promise.resolve(),
      persistChain: Promise.resolve(),
      asr: null,
      audioChain: Promise.resolve(),
      asrBacklog: 0,
      attachDeadline: null,
      pendingFinalize: null,
      asrFault: false,
      transcriptIncomplete: false,
      maxConfirmedSegmentId: -1,
      pausedAttachDeadline: null,
      manuallyPaused: false,
      clientEnded: false,
      audioManifest: null,
    };
    this.sessions.set(sessionId, session);
    if (socket) this.socketToSession.set(socket.id, sessionId);
    return session;
  }

  // ---- 转写 --------------------------------------------------------------

  /** ASR 统一片段：同一 segmentId 临时替换、最终落定。 */
  private applySegment(session: RecordingSession, segment: AsrTranscriptSegment): void {
    if (session.status === 'ended' || session.status === 'failed') return;
    if (segment.segmentId <= session.maxConfirmedSegmentId) return;
    if (!segment.isFinal) {
      const merged: ConfirmedSegment = {
        segmentId: segment.segmentId,
        text: segment.text,
        startMs: segment.startMs,
        endMs: null,
        speakerId: segment.speakerId,
      };
      session.transientSegments.set(segment.segmentId, merged);
      if (session.socket) {
        session.socket.emit('minutes_transcript', {
          sessionId: session.sessionId,
          segments: [{ ...merged, isFinal: false }],
        });
      }
      return;
    }
    // 最终结果覆盖临时句并落定，不重复追加；finalizing 期间仍接收最终结果。
    session.transientSegments.delete(segment.segmentId);
    if (!segment.text.trim()) return;
    session.maxConfirmedSegmentId = segment.segmentId;
    const confirmed: ConfirmedSegment = {
      segmentId: segment.segmentId,
      text: segment.text,
      startMs: segment.startMs,
      endMs: segment.endMs,
      speakerId: segment.speakerId,
      words: segment.words,
    };
    session.confirmedSegments.push(confirmed);
    if (session.socket) {
      session.socket.emit('minutes_transcript', {
        sessionId: session.sessionId,
        segments: [{ ...confirmed, isFinal: true }],
      });
    }
    this.queueCheckpoint(session);
  }

  /** 确认句串行写检查点；失败保留内存内容并记录，不静默丢弃。 */
  private queueCheckpoint(session: RecordingSession): void {
    session.checkpointChain = session.checkpointChain
      .catch(() => undefined)
      .then(async () => {
        const durationSeconds = Math.floor(session.acceptedSamples / AUDIO_FORMAT.sampleRate);
        await MeetingMinutes.update(
          {
            transcript: this.toPlainText(session),
            transcriptJson: JSON.stringify(
              session.confirmedSegments.map((s) => ({
                segmentId: s.segmentId,
                text: s.text,
                startMs: s.startMs,
                endMs: s.endMs,
                speakerId: s.speakerId,
                words: s.words,
              })),
            ),
            durationSeconds,
          },
          { where: { sessionId: session.sessionId } },
        );
      })
      .catch((error) => {
        console.error('meeting_minutes_checkpoint_failed', {
          sessionId: session.sessionId,
          type: (error as Error)?.message,
        });
      });
  }

  private toPlainText(session: RecordingSession): string {
    return session.confirmedSegments.map((s) => s.text).filter(Boolean).join('\n');
  }

  // ---- 收尾 --------------------------------------------------------------

  private finalize(session: RecordingSession, endReason: string): Promise<FinalizeResult> {
    if (this.pendingDiscards.has(session.sessionId)) {
      return Promise.resolve({ ok: false, error: 'SESSION_NOT_FOUND', durationSeconds: 0, transcriptComplete: false });
    }
    if (session.status === 'ended' || session.status === 'failed') {
      return Promise.resolve({
        ok: true,
        durationSeconds: Math.floor(session.acceptedSamples / AUDIO_FORMAT.sampleRate),
        transcriptComplete: !session.transcriptIncomplete,
      });
    }
    if (session.pendingFinalize) return session.pendingFinalize;
    session.status = 'finalizing';
    this.cancelAttachDeadline(session);
    const promise = this.runFinalize(session, endReason).finally(() => {
      if (session.pendingFinalize === promise) session.pendingFinalize = null;
    });
    session.pendingFinalize = promise;
    return promise;
  }

  private async runFinalize(session: RecordingSession, endReason: string): Promise<FinalizeResult> {
    await session.persistChain;
    try { session.audioManifest = await this.audioStore.updateManifest(session.sessionId, { clientComplete: session.clientEnded }); }
    catch (error) { console.error('meeting_audio_completion_persist_failed', { sessionId: session.sessionId, message: (error as Error).message }); }
    // 所有已接纳分片先持久化并排入 ASR，然后才结束上游。
    await session.audioChain.catch(() => undefined);
    await MeetingMinutes.update({ status: 'finalizing', endReason }, { where: { sessionId: session.sessionId } });
    publishMeetingChange(session.userId, session.sessionId);
    const asrComplete = (await this.finishAsr(session)) && !session.transcriptIncomplete;
    if (!asrComplete) session.transcriptIncomplete = true;
    this.closeAsr(session);
    await session.checkpointChain;
    const durationSeconds = Math.floor(session.acceptedSamples / AUDIO_FORMAT.sampleRate);
    const status: RecordingStatus = asrComplete ? 'ended' : 'failed';
    // 统一收尾链路：流式封装 WAV → 上传七牛私有空间 → 更新数据库 → 清理本地暂存。
    // 音频保存失败不阻止转写保存（音频状态与转写状态独立）。
    const audio = await this.saveAudio(session, durationSeconds);
    const queueFinalMinutes = endReason === 'ended' && session.acceptedSamples > 0;
    try {
      await MeetingMinutes.update(
        {
          status,
          durationSeconds,
          transcript: this.toPlainText(session),
          transcriptJson: JSON.stringify(
            session.confirmedSegments.map((s) => ({
              segmentId: s.segmentId,
              text: s.text,
              startMs: s.startMs,
              endMs: s.endMs,
              speakerId: s.speakerId,
              words: s.words,
            })),
          ),
          endedAt: new Date(),
          endReason,
          ...(queueFinalMinutes ? { summaryStatus: 'generating', summaryError: FINAL_TRANSCRIPT_PENDING } : {}),
          audioStatus: audio.status,
          audioStorageRef: audio.storageRef ?? undefined,
          audioSize: audio.size,
          audioError: audio.error,
          audioPausedAttachDeadline: null,
          audioRetryAt: audio.status === 'failed' ? new Date(Date.now() + 60_000) : null,
        },
        { where: { sessionId: session.sessionId } },
      );
    } catch (error) {
      console.error('meeting_minutes_finalize_failed', {
        sessionId: session.sessionId,
        type: (error as Error)?.message,
      });
      return { ok: false, error: 'PERSIST_FAILED', durationSeconds, transcriptComplete: asrComplete, audioStatus: audio.status };
    }
    // 音频已持久化（ready/partial）时清理本地暂存；失败时保留本地文件供重试。
    if (!queueFinalMinutes && (audio.status === 'ready' || audio.status === 'partial' || audio.status === 'missing')) {
      await this.audioStore.removeLocal(session.sessionId).catch(async (error) => {
        await MeetingMinutes.update({ audioRetryAt: new Date(Date.now() + 60_000), audioError: 'local_cleanup_failed' }, { where: { sessionId: session.sessionId } });
        console.error('meeting_minutes_local_cleanup_failed', { sessionId: session.sessionId, type: (error as Error)?.message });
      });
    }
    session.status = status;
    const result: FinalizeResult = { ok: true, durationSeconds, transcriptComplete: asrComplete, audioStatus: audio.status };
    this.saveResult(session, result);
    this.teardownSession(session);
    publishMeetingChange(session.userId, session.sessionId);
    if (queueFinalMinutes) this.kickFinalMinutes();
    return result;
  }

  /** 统一音频保存：封装 WAV（幂等）→ 上传七牛（固定对象 key，重试不产生新对象）。 */
  private async saveAudio(
    session: RecordingSession,
    durationSeconds: number,
  ): Promise<{ status: MeetingAudioStatus; storageRef: string | null; error: string | null; size?: number }> {
    // 等待已接纳的持久化写入完成，再冻结封装边界。
    await session.persistChain.catch(() => undefined);
    const loaded = await this.audioStore.loadManifest(session.sessionId);
    if (loaded.ok === false) {
      // manifest 不可读（损坏/IO 错误）：不标 missing（可能仍有音频），标 failed 保留文件。
      console.error('meeting_minutes_audio_manifest_unavailable', {
        sessionId: session.sessionId,
        reason: loaded.reason,
        type: loaded.message,
      });
      return { status: 'failed', storageRef: null, error: `manifest_${loaded.reason}` };
    }
    const manifest = loaded.manifest;
    if (manifest.acceptedSamples === 0) {
      // 没有任何已持久化音频：标记 missing，不创建对象。
      return { status: 'missing', storageRef: null, error: null, size: 0 };
    }
    // 尾片完整性：客户端未正常结束（断线/重启/撤销）或封装遇缺口，无法确认最后一片完整，标记 partial。
    const clientIncomplete = !session.clientEnded;
    try {
      await this.persistAudioState(session, { status: 'uploading', storageRef: null, error: null });
      const encoded = await this.audioStore.encodeWav(session.sessionId, AUDIO_FORMAT.sampleRate, manifest.lastAcceptedAudioIndex);
      if (!encoded.filePath) {
        // 无可用分片（不应发生，acceptedSamples>0 时至少有片）：标 missing。
        throw new Error('confirmed_audio_missing');
      }
      const record = await MeetingMinutes.findOne({
        where: { sessionId: session.sessionId },
        attributes: ['audioStorageRef'],
      });
      const uploaded = await this.audioStore.uploadToQiniu(session.sessionId, record?.audioStorageRef ?? null);
      const partial = clientIncomplete || !encoded.complete;
      return { status: partial ? 'partial' : 'ready', storageRef: uploaded.storageRef, error: null, size: encoded.dataBytes + 44 };
    } catch (error) {
      // 本地分片与 WAV 保留供幂等重试；不删除、不更换对象 key。
      console.error('meeting_minutes_audio_save_failed', {
        sessionId: session.sessionId,
        type: (error as Error)?.message,
      });
      return { status: 'failed', storageRef: null, error: errorType(error) };
    }
  }

  private async persistAudioState(
    session: Pick<RecordingSession, 'sessionId'>,
    audio: { status: MeetingAudioStatus; storageRef: string | null; error: string | null; size?: number },
  ): Promise<void> {
    await MeetingMinutes.update(
      { audioStatus: audio.status, audioError: audio.error },
      { where: { sessionId: session.sessionId } },
    );
  }

  /** 通知 ASR 输入结束并真正等待结束结果或明确超时（不提前丢弃回调）。 */
  private finishAsr(session: RecordingSession): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (!session.asr) {
        resolve(true);
        return;
      }
      const asr = session.asr;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // 收尾超时：保存已有内容并标记转写不完整。
        resolve(false);
      }, ASR_FINISH_TIMEOUT_MS);
      timer.unref?.();
      asr.finish().then(() => {
        // ASR 正常完成最终识别。
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      }).catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(false);
      });
    });
  }

  private saveResult(session: RecordingSession, result: FinalizeResult): void {
    this.savedResults.set(session.sessionId, { userId: session.userId, result });
    // LRU 淘汰：超出上限时删除最早插入的条目。
    if (this.savedResults.size > MeetingRecordingService.MAX_SAVED_RESULTS) {
      const oldest = this.savedResults.keys().next().value;
      if (oldest) this.savedResults.delete(oldest);
    }
  }

  private teardownSession(session: RecordingSession): void {
    this.cancelAttachDeadline(session);
    session.asr?.close();
    session.asr = null;
    this.sessions.delete(session.sessionId);
    if (this.activeByUser.get(session.userId) === session.sessionId) {
      this.activeByUser.delete(session.userId);
    }
    if (session.socket) this.socketToSession.delete(session.socket.id);
  }

  // ---- 暂停/断线期限 ------------------------------------------------------
  // 权威截止时间在数据库 audioPausedAttachDeadline（进程重启后仍有效）；
  // 内存 timer 只负责本进程内的到期收尾。

  /**
   * 设置暂停恢复截止时间并落库。
   * @param deadline 目标截止时间（毫秒）；null 表示清除（录制恢复中）。
   */
  private async schedulePausedDeadline(session: RecordingSession, deadline: number | null): Promise<void> {
    // 先取消旧定时器再替换句柄，不先清空导致无法取消。
    this.cancelAttachDeadline(session);
    session.pausedAttachDeadline = deadline;
    if (deadline === null) { await this.persistPausedAttachDeadline(session, deadline); return; }
    const expire = () => {
      session.attachDeadline = null;
      if (session.status !== 'recording' && session.status !== 'paused') return;
      void this.finalize(session, 'pause_expired').catch(error =>
        console.error('meeting_deadline_finalize_failed', { sessionId: session.sessionId, message: error.message }));
    };
    const remaining = deadline - Date.now();
    if (remaining <= 0) { expire(); return; }
    session.attachDeadline = setTimeout(expire, remaining);
    session.attachDeadline.unref?.();
    await this.persistPausedAttachDeadline(session, deadline);
  }

  private async persistPausedAttachDeadline(
    session: RecordingSession,
    deadline: number | null,
  ): Promise<void> {
    const status = session.status === 'paused' ? 'paused' : 'recording';
    // DB 与 manifest 一起排队，避免断线、暂停和恢复的异步写入互相覆盖。
    await (session.persistChain = session.persistChain.catch(() => undefined).then(async () => {
      await MeetingMinutes.update(
        { audioPausedAttachDeadline: deadline === null ? null : new Date(deadline), status,
          durationSeconds: Math.floor(session.acceptedSamples / AUDIO_FORMAT.sampleRate) },
        { where: { sessionId: session.sessionId, status: { [Op.in]: ['recording', 'paused'] } } },
      );
      publishMeetingChange(session.userId, session.sessionId);
      session.audioManifest = await this.audioStore.updateManifest(session.sessionId, { pausedAttachDeadline: deadline });
    }));
  }

  private cancelAttachDeadline(session: RecordingSession): void {
    if (session.attachDeadline) {
      clearTimeout(session.attachDeadline);
      session.attachDeadline = null;
    }
  }

  // ---- 生命周期 ----------------------------------------------------------

  /**
   * 启动恢复：
   * - 活动录音（recording/paused/finalizing）：暂停未过期保留草稿（重建会话+截止任务），
   *   其余封装已有分片上传，尾片不完整标 partial；
   * - 已结束但音频保存未完成（ended/failed 且 audioStatus 为 pending/uploading/failed）：
   *   从已有阶段续传重试，避免重复对象与重复收尾；
   * - 音频状态与转写状态独立：恢复音频不覆盖已确认转写。
   */
  async markOrphanedSessions(): Promise<void> {
    this.startAudioTasks();
    // 进程重启遗留的纪要 generating 状态：允许重试。
    try {
      await MeetingMinutes.update(
        { summaryStatus: 'failed', summaryError: 'process_restart' },
        { where: { summaryStatus: 'generating', summaryError: null } },
      );
    } catch (error) {
      console.error('meeting_minutes_orphan_mark_failed', { type: (error as Error)?.message });
    }
    // 类①：活动录音。
    let activeRows: MeetingMinutes[] = [];
    try {
      activeRows = await MeetingMinutes.findAll({
        where: { status: { [Op.in]: ['recording', 'paused', 'finalizing'] } },
        attributes: ['sessionId', 'userId', 'status', 'audioPausedAttachDeadline', 'durationSeconds'],
      });
    } catch (error) {
      console.error('meeting_minutes_orphan_scan_failed', { type: (error as Error)?.message });
    }
    for (const row of activeRows) {
      await this.resumeOrphanedRecording(row).catch((error) => {
        console.error('meeting_minutes_orphan_resume_failed', {
          sessionId: row.sessionId,
          type: (error as Error)?.message,
        });
        void MeetingMinutes.update(
          { audioStatus: 'failed', audioError: errorType(error) },
          { where: { sessionId: row.sessionId } },
        ).catch(() => undefined);
      });
    }
    await MeetingMinutes.update({ audioStatus: 'pending' }, { where: { status: { [Op.in]: ['ended', 'failed'] }, audioStatus: 'uploading' } });
    // 已结束音频统一经过 DB 抢占的重试入口。
    let audioPendingRows: MeetingMinutes[] = [];
    try {
      audioPendingRows = await MeetingMinutes.findAll({
        where: {
          status: { [Op.in]: ['ended', 'failed'] },
          audioStatus: { [Op.in]: ['pending', 'uploading', 'failed'] },
        },
        attributes: ['sessionId', 'status', 'audioStorageRef', 'durationSeconds'],
      });
    } catch (error) {
      console.error('meeting_minutes_audio_retry_scan_failed', { type: (error as Error)?.message });
    }
    if (audioPendingRows.length > 0) {
      console.warn('meeting_minutes_audio_retry', { count: audioPendingRows.length });
    }
    for (const row of audioPendingRows) {
      await retryMeetingAudio(row.sessionId).catch((error) => {
        console.error('meeting_minutes_audio_retry_failed', {
          sessionId: row.sessionId,
          type: (error as Error)?.message,
        });
      });
    }
    if (activeRows.length > 0) {
      console.warn('meeting_minutes_orphans_recovered', { count: activeRows.length });
    }
    this.kickFinalMinutes();
  }

  /** 恢复单场遗留活动录音。 */
  private async resumeOrphanedRecording(row: MeetingMinutes): Promise<void> {
    const sessionId = row.sessionId;
    const deadline = row.audioPausedAttachDeadline ? new Date(row.audioPausedAttachDeadline).getTime() : null;
    const now = Date.now();
    // 暂停中且截止时间未过期：重建可恢复会话（归属/进度/截止任务），不自动开麦。
    if (row.status === 'paused' && (deadline === null || deadline > now)) {
      await this.restoreResumableSession(row, deadline);
      return;
    }
    // 其余情况收尾：尾片完整性无法确认（进程曾中断），标记 partial；无分片标 missing。
    await this.finalizeOrphanedRecording(row);
  }

  /** 重建暂停且未过期的可恢复会话：注册归属、持久化进度与截止任务，等待用户 attach+resume。 */
  private async restoreResumableSession(row: MeetingMinutes, deadline: number | null): Promise<void> {
    const loaded = await this.audioStore.loadManifest(row.sessionId);
    const manifest = loaded.ok ? loaded.manifest : await this.audioStore.recoverManifest(row.sessionId);
    if (!manifest.sid || manifest.userId !== row.userId) {
      await this.finalizeOrphanedRecording(row);
      return;
    }
    const user = { userId: row.userId, sid: manifest.sid } as AuthenticatedSessionPayload;
    const session = this.createSession(row.sessionId, user, null);
    session.status = 'paused';
    session.manuallyPaused = true;
    session.audioManifest = manifest;
    session.acceptedSamples = manifest.acceptedSamples;
    session.lastAcceptedAudioIndex = manifest.lastAcceptedAudioIndex;
    session.transcriptIncomplete = true;
    // 恢复保存的确认句，避免后续检查点将旧文字覆盖为空。
    const record = await MeetingMinutes.findByPk(row.sessionId);
    session.confirmedSegments = record?.transcriptJson ? JSON.parse(record.transcriptJson) : [];
    session.maxConfirmedSegmentId = Math.max(-1, ...session.confirmedSegments.map(segment => segment.segmentId));
    this.activeByUser.set(row.userId, row.sessionId);
    await this.schedulePausedDeadline(session, deadline ?? Date.now() + ATTACH_DEADLINE_MS);
  }

  /** 收尾单场遗留活动录音（recording/finalizing/过期暂停）：封装→上传→更新→清理。 */
  private async finalizeOrphanedRecording(row: MeetingMinutes): Promise<void> {
    const sessionId = row.sessionId;
    const record = await MeetingMinutes.findOne({ where: { sessionId } });
    if (!record) return;
    const audio = await this.finalizeOrphanedAudio(sessionId, record);
    const queueFinalMinutes = record.endReason === 'ended' && audio.status !== 'missing';
    // 转写在进程中断时不完整，统一标记 failed 保留已有内容；音频状态独立。
    await MeetingMinutes.update(
      {
        status: 'failed',
        endedAt: new Date(),
        endReason: queueFinalMinutes ? 'ended' : 'process_restart',
        ...(queueFinalMinutes ? { summaryStatus: 'generating', summaryError: FINAL_TRANSCRIPT_PENDING } : {}),
        audioStatus: audio.status,
        audioStorageRef: audio.storageRef ?? undefined,
        audioSize: audio.size,
        audioError: audio.error,
        audioPausedAttachDeadline: null,
        audioRetryAt: audio.status === 'failed' ? new Date(Date.now() + 60_000) : null,
      },
      { where: { sessionId } },
    );
    if (!queueFinalMinutes && (audio.status === 'ready' || audio.status === 'partial' || audio.status === 'missing')) {
      await this.audioStore.removeLocal(sessionId).catch(async (error) => {
        await MeetingMinutes.update({ audioRetryAt: new Date(Date.now() + 60_000), audioError: 'local_cleanup_failed' }, { where: { sessionId } });
        console.error('meeting_minutes_local_cleanup_failed', { sessionId, type: (error as Error)?.message });
      });
    }
  }

  /** 收尾单场遗留录音的音频：封装 WAV → 上传七牛（幂等）。 */
  private async finalizeOrphanedAudio(
    sessionId: string,
    record: MeetingMinutes,
  ): Promise<{ status: MeetingAudioStatus; storageRef: string | null; error: string | null; size?: number }> {
    const loaded = await this.audioStore.loadManifest(sessionId);
    if (loaded.ok === false) {
      if (loaded.reason === 'not_found') {
        return { status: 'failed', storageRef: record.audioStorageRef, error: 'manifest_missing' };
      }
      // 损坏/IO 错误：可能仍有音频，标 failed 保留文件，不按 missing 清理。
      return { status: 'failed', storageRef: null, error: `manifest_${loaded.reason}` };
    }
    const manifest = loaded.manifest;
    if (manifest.acceptedSamples === 0) {
      return { status: 'missing', storageRef: null, error: null, size: 0 };
    }
    try {
      await MeetingMinutes.update(
        { audioStatus: 'uploading' },
        { where: { sessionId } },
      );
      const encoded = await this.audioStore.encodeWav(sessionId, AUDIO_FORMAT.sampleRate, manifest.lastAcceptedAudioIndex);
      if (!encoded.filePath) {
        throw new Error('confirmed_audio_missing');
      }
      const uploaded = await this.audioStore.uploadToQiniu(sessionId, record.audioStorageRef ?? null);
      // 进程曾中断：尾片完整性无法证明，标记 partial。
      return { status: 'partial', storageRef: uploaded.storageRef, error: null, size: encoded.dataBytes + 44 };
    } catch (error) {
      console.error('meeting_minutes_orphan_audio_save_failed', {
        sessionId,
        type: (error as Error)?.message,
      });
      return { status: 'failed', storageRef: null, error: errorType(error) };
    }
  }

  async queueTranscriptRegeneration(sessionId: string, userId: number): Promise<boolean> {
    const [claimed] = await MeetingMinutes.update(
      { summaryStatus: 'generating', summaryError: REGENERATE_TRANSCRIPT_PENDING },
      { where: { sessionId, userId, status: { [Op.in]: ['ended', 'failed'] }, summaryStatus: { [Op.ne]: 'generating' },
        [Op.or]: [
          { audioStatus: { [Op.in]: ['ready', 'partial'] }, audioStorageRef: { [Op.ne]: null } },
          { audioStatus: { [Op.in]: ['pending', 'failed'] }, summaryError: FINAL_TRANSCRIPT_FAILED },
        ] } },
    );
    if (claimed) {
      publishMeetingChange(userId, sessionId);
      this.kickFinalMinutes();
    }
    return claimed > 0;
  }

  async queueSummaryRegeneration(sessionId: string, userId: number): Promise<boolean> {
    const [claimed] = await MeetingMinutes.update(
      { summaryStatus: 'generating', summaryError: FINAL_SUMMARY_PENDING },
      { where: { sessionId, userId, status: { [Op.in]: ['ended', 'failed'] },
        summaryStatus: { [Op.ne]: 'generating' }, audioStatus: { [Op.ne]: 'deleting' } } },
    );
    if (claimed) {
      publishMeetingChange(userId, sessionId);
      this.kickFinalMinutes();
    }
    return claimed > 0;
  }

  private kickFinalMinutes(): void {
    if (!this.tasksTimer || this.closed) return;
    if (this.finalMinutesTask) {
      this.finalMinutesRequested = true;
      return;
    }
    this.finalMinutesRequested = false;
    this.finalMinutesTask = this.processFinalMinutes()
      .catch(error => console.error('meeting_final_minutes_task_failed', errorType(error)))
      .finally(() => {
        this.finalMinutesTask = null;
        if (this.finalMinutesRequested) this.kickFinalMinutes();
      });
  }

  private async processFinalMinutes(): Promise<void> {
    const { signal } = this.finalMinutesLifetime;
    while (!signal.aborted) {
      const record = await MeetingMinutes.findOne({
        where: { summaryStatus: 'generating', summaryError: { [Op.in]: [FINAL_TRANSCRIPT_PENDING, REGENERATE_TRANSCRIPT_PENDING, FINAL_SUMMARY_PENDING] } },
        order: [['endedAt', 'ASC'], ['sessionId', 'ASC']],
      });
      if (!record || signal.aborted) return;
      if (record.summaryError === FINAL_TRANSCRIPT_PENDING || record.summaryError === REGENERATE_TRANSCRIPT_PENDING) {
        let segments: Awaited<ReturnType<typeof transcribeMeetingWav>>;
        try {
          segments = await this.replaySavedAudio(record, signal);
        } catch (error) {
          if (signal.aborted) return;
          console.error('meeting_final_transcript_failed', { sessionId: record.sessionId, type: errorType(error) });
          await record.update({ summaryStatus: 'failed', summaryError: FINAL_TRANSCRIPT_FAILED });
          publishMeetingChange(record.userId, record.sessionId);
          continue;
        }
        if (signal.aborted) return;
        const transcript = segments.map(segment => segment.text).join('\n');
        await record.update({ transcript, transcriptJson: JSON.stringify(segments), status: 'ended', summaryError: FINAL_SUMMARY_PENDING });
        publishMeetingChange(record.userId, record.sessionId);
      }

      // 重启后可从已落库的最终转写继续生成纪要，无需重放音频。
      const cleanup = ['ready', 'partial'].includes(record.audioStatus)
        ? { audioError: 'local_cleanup_pending', audioRetryAt: new Date() } : {};
      if (!record.transcript.trim()) {
        await record.update({ summaryStatus: 'idle', summaryError: null, ...cleanup });
        publishMeetingChange(record.userId, record.sessionId);
        continue;
      }
      let summary: Awaited<ReturnType<typeof generateMeetingSummary>>;
      try {
        summary = await generateMeetingSummary(record.transcript);
      } catch (error) {
        if (signal.aborted) return;
        await record.update({ summaryStatus: 'failed', summaryError: error instanceof SummaryError ? error.type : 'network', ...cleanup });
        publishMeetingChange(record.userId, record.sessionId);
        continue;
      }
      if (signal.aborted) return;
      if (summary.title && !record.title) {
        await MeetingMinutes.update({ title: summary.title }, { where: { sessionId: record.sessionId, title: '' } });
      }
      await record.update({ summary: summary.summary, keyPoints: JSON.stringify(summary.keyPoints), mindmap: summary.mindmap,
        summaryStatus: 'ready', summaryError: null, ...cleanup });
      publishMeetingChange(record.userId, record.sessionId);
    }
  }

  private async replaySavedAudio(record: MeetingMinutes, signal: AbortSignal) {
    const { sessionId, audioStorageRef } = record;
    const wavPath = this.audioStore.wavPath(sessionId);
    const wav = await stat(wavPath).catch(() => null);
    const archive = audioStorageRef && parseStorageReference(audioStorageRef)?.scope === 'private';
    if (archive && (!wav || record.audioError?.startsWith('local_cleanup_'))) {
      return transcribeStoredMeetingWav(this.asr, this.audioStore.resolveUrl(audioStorageRef), signal);
    }
    if (!wav) {
      const loaded = await this.audioStore.loadManifest(sessionId);
      if (!loaded.ok) throw new Error('manifest_unavailable');
      // 七牛上传失败时仍可从持久化分片封装。
      const encoded = await this.audioStore.encodeWav(sessionId, AUDIO_FORMAT.sampleRate, loaded.manifest.lastAcceptedAudioIndex);
      if (!encoded.filePath) throw new Error('audio_unavailable');
    }
    return transcribeMeetingWav(this.asr, wavPath, signal);
  }

  startAudioTasks(): void {
    if (this.tasksTimer || this.closed) return;
    this.tasksTimer = setInterval(() => {
      this.kickFinalMinutes();
      if (this.tasksPromise) return;
      this.tasksPromise = processMeetingAudioTasks().catch(error =>
        console.error('meeting_audio_tasks_failed', error.message)).finally(() => { this.tasksPromise = null; });
    }, 60_000);
    this.tasksTimer.unref?.();
  }

  /** 关停：等待所有会话完成保存与 ASR 释放。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.finalMinutesLifetime.abort();
    if (this.tasksTimer) clearInterval(this.tasksTimer);
    await this.tasksPromise;
    await Promise.allSettled([...this.creatingByUser.values()]);
    await Promise.allSettled([...this.pendingDiscards.values()]);
    this.unsubscribeRevocation?.();
    this.unsubscribeRevocation = null;
    const pending = [...this.sessions.values()].map((session) => this.finalize(session, 'server_shutdown'));
    await Promise.allSettled(pending);
  }
}

/** 把异常压缩为可入库的短错误类别（audioError，长度 ≤ 64）。 */
function errorType(error: unknown): string {
  const message = (error as Error)?.message || 'UNKNOWN';
  return message.slice(0, 64);
}

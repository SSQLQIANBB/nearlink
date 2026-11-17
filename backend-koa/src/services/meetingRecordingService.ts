import { Op } from 'sequelize';
import { randomUUID } from 'crypto';
import type { Socket } from 'socket.io';
import {
  AuthenticatedSessionPayload,
  onLoginSessionsRevoked,
} from './loginSessionService';
import { AsrClient, type AsrSessionHandle, type AsrTranscriptSegment } from './asrClient';
import { MeetingMinutes } from '../models/MeetingMinutes';

/**
 * 会议录音会话服务。
 *
 * 职责（与 Socket 配置分离）：
 * - 会话归属与生命周期状态转换（recording/paused/finalizing/ended/failed）；
 * - sessionId 由服务端创建（start 不允许携带），每次操作校验归属；
 * - 音频顺序与去重（lastAcceptedAudioIndex / acceptedSamples，按实际字节数计样本）；
 * - ASR 编排（串行转发、有界发送积压、结束等待）与转写检查点持久化；
 * - 断线有界恢复期限与收尾（disconnect_timeout）；
 * - 登录撤销终止恢复资格；启动时把上次进程遗留的活动录音标为异常终止。
 *
 * 注意：`/meeting-minutes` 是 Socket.IO 的 path，不是 namespace。
 * 协议见 docs/MEETING_RECORDING_PROTOCOL.md。
 *
 * ACK 语义：音频确认表示"当前进程已接收并交给 ASR"，不代表原始音频已持久化；
 * 进程重启后未确认音频不可恢复。
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
/** 断线恢复期限（毫秒）：超时收尾保存已识别内容。 */
const ATTACH_DEADLINE_MS = 5 * 60 * 1000;
/** ASR 收尾等待超时（毫秒）。 */
const ASR_FINISH_TIMEOUT_MS = 30_000;

export type RecordingStatus = 'recording' | 'paused' | 'finalizing' | 'ended' | 'failed';

interface ConfirmedSegment {
  segmentId: number;
  text: string;
  startMs: number;
  endMs: number | null;
  speakerId: string | null;
}

export interface FinalizeResult {
  ok: boolean;
  error?: string;
  durationSeconds: number;
  transcriptComplete: boolean;
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
}

type RecordingAsr = Pick<AsrClient, 'backend' | 'open'>;

export class MeetingRecordingService {
  private readonly asr: RecordingAsr;
  private readonly sessions = new Map<string, RecordingSession>();
  private readonly activeByUser = new Map<number, string>();
  private readonly creatingByUser = new Map<number, Promise<RecordingSession | null>>();
  private readonly socketToSession = new Map<string, string>();
  private readonly revocableSockets = new Map<string, string>();
  private unsubscribeRevocation: (() => void) | null = null;
  private closed = false;
  /** 已完成收尾的会话结果缓存（end ACK 丢失后重复 end 可读取）。LRU 上限。 */
  private readonly savedResults = new Map<string, { userId: number; result: FinalizeResult }>();
  private static readonly MAX_SAVED_RESULTS = 200;

  constructor(options: { asr: RecordingAsr }) {
    this.asr = options.asr;
  }

  /** 连接握手成功后调用；绑定用户身份并注册撤销监听。 */
  onConnect(socket: Socket, user: AuthenticatedSessionPayload): void {
    this.revocableSockets.set(socket.id, `${user.userId}:${user.sid}`);
    if (!this.unsubscribeRevocation) {
      this.unsubscribeRevocation = onLoginSessionsRevoked((event) => {
        void this.revokeUserSessions(event.userId, event.sid);
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
    if (session.status === 'recording' || session.status === 'paused') {
      // 解绑连接，但保留会议和已确认转写。
      session.status = 'paused';
      this.finishPausedTencentStream(session);
      this.startAttachDeadline(session);
    }
  }

  private async revokeUserSessions(userId: number, sid?: string): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      if (session.userId !== userId) continue;
      if (sid && session.sid !== sid) continue;
      // 用户主动结束、退出登录或授权撤销不能按普通网络故障恢复。
      await this.finalize(session, 'auth_revoked');
    }
  }

  // ---- 控制操作 ----------------------------------------------------------

  /** start：创建会话。不允许携带 sessionId；ASR 不可用时拒绝且不建记录。 */
  async start(
    socket: Socket,
    user: AuthenticatedSessionPayload,
  ): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
    if (this.closed) return { ok: false, error: 'INTERNAL' };
    const activeId = this.activeByUser.get(user.userId);
    if (activeId) {
      const active = this.sessions.get(activeId);
      if (active && (active.status === 'recording' || active.status === 'paused')) {
        return { ok: false, error: 'SESSION_ACTIVE' };
      }
    }
    if (this.creatingByUser.has(user.userId)) {
      // 并发 start：先占用"正在创建"位置，防止两个 start 同时创建资源。
      const result = await this.creatingByUser.get(user.userId);
      return result ? { ok: true, sessionId: result.sessionId } : { ok: false, error: 'ASR_UNAVAILABLE' };
    }
    const creation = this.doStart(socket, user);
    this.creatingByUser.set(user.userId, creation);
    try {
      const session = await creation;
      return session ? { ok: true, sessionId: session.sessionId } : { ok: false, error: 'ASR_UNAVAILABLE' };
    } finally {
      this.creatingByUser.delete(user.userId);
    }
  }

  private async doStart(
    socket: Socket,
    user: AuthenticatedSessionPayload,
  ): Promise<RecordingSession | null> {
    // 先验证并建立 ASR；失败不留任何记录/资源（数据库创建失败必须关闭已创建的 ASR）。
    const session = this.createSession(randomUUID(), user, socket);
    try {
      await this.openAsr(session, 0);
      if (!session.socket || this.closed) {
        this.teardownSession(session);
        return null;
      }
    } catch (error) {
      console.error('meeting_minutes_asr_open_failed', { sessionId: session.sessionId, type: (error as Error)?.message });
      this.teardownSession(session);
      return null;
    }
    try {
      await MeetingMinutes.create({
        sessionId: session.sessionId,
        userId: user.userId,
        title: '',
        source: 'offline',
        status: 'recording',
        durationSeconds: 0,
        transcript: '',
        transcriptJson: '[]',
      });
    } catch (error) {
      // 数据库创建失败：关闭已创建的 ASR，不留悬挂资源。
      session.asr?.close();
      this.teardownSession(session);
      console.error('meeting_minutes_create_failed', { sessionId: session.sessionId, type: (error as Error)?.message });
      return null;
    }
    this.activeByUser.set(user.userId, session.sessionId);
    return session;
  }

  /** attach：重连后重新绑定已有会话（校验归属与可恢复性）。 */
  async attach(
    socket: Socket,
    user: AuthenticatedSessionPayload,
    sessionId: string,
  ): Promise<
    | { ok: true; status: RecordingStatus; lastAcceptedAudioIndex: number; acceptedSamples: number }
    | { ok: false; error: string }
  > {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== user.userId) return { ok: false, error: 'SESSION_NOT_FOUND' };
    // 校验登录会话 sid：同一用户不同登录会话不可抢占。
    if (user.sid && session.sid && user.sid !== session.sid) return { ok: false, error: 'FORBIDDEN' };
    if (session.status === 'ended' || session.status === 'failed' || session.status === 'finalizing') {
      return { ok: false, error: 'SESSION_NOT_FOUND' };
    }
    // 同一录音仅允许一个活动上传连接：先解绑旧连接。
    if (session.socket && session.socket !== socket) {
      this.socketToSession.delete(session.socket.id);
    }
    this.cancelAttachDeadline(session);
    session.socket = socket;
    this.socketToSession.set(socket.id, session.sessionId);
    return {
      ok: true,
      status: session.status,
      lastAcceptedAudioIndex: session.lastAcceptedAudioIndex,
      acceptedSamples: session.acceptedSamples,
    };
  }

  async pause(
    socket: Socket,
    user: AuthenticatedSessionPayload,
    sessionId: string,
  ): Promise<{ ok: true; lastAcceptedAudioIndex: number } | { ok: false; error: string }> {
    const session = this.requireOwnedSession(user, sessionId);
    if (!session) return { ok: false, error: 'SESSION_NOT_FOUND' };
    if (session.socket !== socket) return { ok: false, error: 'FORBIDDEN' };
    if (session.status === 'recording') {
      session.status = 'paused';
      this.finishPausedTencentStream(session);
    }
    return { ok: true, lastAcceptedAudioIndex: session.lastAcceptedAudioIndex };
  }

  async resume(
    socket: Socket,
    user: AuthenticatedSessionPayload,
    sessionId: string,
  ): Promise<{ ok: true; lastAcceptedAudioIndex: number } | { ok: false; error: string }> {
    const session = this.requireOwnedSession(user, sessionId);
    if (!session) return { ok: false, error: 'SESSION_NOT_FOUND' };
    if (session.socket !== socket) return { ok: false, error: 'FORBIDDEN' };
    if (session.status === 'paused') {
      session.asrFault = false;
      session.status = 'recording';
    }
    return { ok: true, lastAcceptedAudioIndex: session.lastAcceptedAudioIndex };
  }

  /** end：收尾屏障。重复 end 复用同一收尾 Promise；落库失败不返回成功。 */
  async end(
    socket: Socket,
    user: AuthenticatedSessionPayload,
    sessionId: string,
    lastAudioIndex: number,
  ): Promise<
    | { ok: true; durationSeconds: number; transcriptComplete: boolean }
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
      };
    }
    const session = this.sessions.get(sessionId);
    if (session) {
      if (session.userId !== user.userId) return { ok: false, error: 'SESSION_NOT_FOUND' };
      if (!Number.isSafeInteger(lastAudioIndex) || lastAudioIndex < -1) return { ok: false, error: 'BAD_REQUEST' };
      if (lastAudioIndex > session.lastAcceptedAudioIndex) return { ok: false, error: 'BAD_REQUEST' };
      const result = await this.finalize(session, 'ended');
      if (!result.ok) return { ok: false, error: result.error ?? 'INTERNAL' };
      return { ok: true, durationSeconds: result.durationSeconds, transcriptComplete: result.transcriptComplete };
    }
    // 内存会话已释放（进程重启或 LRU 淘汰）：从数据库读回已保存结果。
    const record = await MeetingMinutes.findOne({
      where: { sessionId, userId: user.userId },
      attributes: ['sessionId', 'status', 'durationSeconds', 'transcriptJson'],
    });
    if (!record) return { ok: false, error: 'SESSION_NOT_FOUND' };
    if (record.status !== 'ended' && record.status !== 'failed') return { ok: false, error: 'BAD_REQUEST' };
    const transcriptComplete = record.status === 'ended';
    const result: FinalizeResult = {
      ok: true,
      durationSeconds: record.durationSeconds ?? 0,
      transcriptComplete,
    };
    this.savedResults.set(sessionId, { userId: user.userId, result });
    return { ok: true, durationSeconds: result.durationSeconds, transcriptComplete };
  }

  private requireOwnedSession(user: AuthenticatedSessionPayload, sessionId: string): RecordingSession | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== user.userId) return null;
    if (session.status === 'finalizing' || session.status === 'ended' || session.status === 'failed') return null;
    return session;
  }

  // ---- 音频 --------------------------------------------------------------

  /** 接收二进制分片；按序去重并串行转发 ASR。ACK 为累计确认值。 */
  onAudio(
    socket: Socket,
    user: AuthenticatedSessionPayload,
    sessionId: string,
    audioIndex: number,
    pcm: Buffer,
  ): { sessionId: string; lastAcceptedAudioIndex: number; acceptedSamples: number; expectedAudioIndex?: number } | { error: string } {
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
    if (audioIndex > session.lastAcceptedAudioIndex + 1) {
      // 序号跳跃：返回期望序号（当前确认值 + 1），不静默跳过。
      return {
        sessionId,
        lastAcceptedAudioIndex: session.lastAcceptedAudioIndex,
        acceptedSamples: session.acceptedSamples,
        expectedAudioIndex: session.lastAcceptedAudioIndex + 1,
      };
    }
    if (audioIndex <= session.lastAcceptedAudioIndex) {
      // 重复序号：返回已有确认，不重复送入 ASR、不重复累计时长。
      return { sessionId, lastAcceptedAudioIndex: session.lastAcceptedAudioIndex, acceptedSamples: session.acceptedSamples };
    }
    if (session.asrFault) return { error: 'ASR_FAULT' };
    if (session.asrBacklog >= MAX_ASR_BACKLOG) return { error: 'SEND_FAILED' };
    // ACK 确认的是有界队列已接收，不是上游识别完成或音频已持久化。
    this.queueAsrFrame(session, pcm, session.acceptedSamples);
    session.lastAcceptedAudioIndex = audioIndex;
    session.acceptedSamples += pcm.length / 2;
    return { sessionId, lastAcceptedAudioIndex: session.lastAcceptedAudioIndex, acceptedSamples: session.acceptedSamples };
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
        if (session.status === 'recording') session.status = 'paused';
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
        });
      },
      onFault: (error) => {
        if (!asr || session.asr !== asr) return;
        console.error('meeting_minutes_asr_fault', { sessionId: session.sessionId, type: error.message });
        this.invalidateAsr(session);
      },
    });
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

  private createSession(sessionId: string, user: AuthenticatedSessionPayload, socket: Socket): RecordingSession {
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
      asr: null,
      audioChain: Promise.resolve(),
      asrBacklog: 0,
      attachDeadline: null,
      pendingFinalize: null,
      asrFault: false,
      transcriptIncomplete: false,
      maxConfirmedSegmentId: -1,
    };
    this.sessions.set(sessionId, session);
    this.socketToSession.set(socket.id, sessionId);
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
    // 等待在途 ASR 转发完成，再通知输入结束并等待最终识别或明确超时。
    await session.audioChain.catch(() => undefined);
    const asrComplete = (await this.finishAsr(session)) && !session.transcriptIncomplete;
    if (!asrComplete) session.transcriptIncomplete = true;
    this.closeAsr(session);
    await session.checkpointChain;
    const durationSeconds = Math.floor(session.acceptedSamples / AUDIO_FORMAT.sampleRate);
    const status: RecordingStatus = asrComplete ? 'ended' : 'failed';
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
            })),
          ),
          endedAt: new Date(),
          endReason,
        },
        { where: { sessionId: session.sessionId } },
      );
    } catch (error) {
      console.error('meeting_minutes_finalize_failed', {
        sessionId: session.sessionId,
        type: (error as Error)?.message,
      });
      return { ok: false, error: 'PERSIST_FAILED', durationSeconds, transcriptComplete: asrComplete };
    }
    session.status = status;
    this.saveResult(session, { ok: true, durationSeconds, transcriptComplete: asrComplete });
    this.teardownSession(session);
    return { ok: true, durationSeconds, transcriptComplete: asrComplete };
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

  // ---- 断线期限 ----------------------------------------------------------

  private startAttachDeadline(session: RecordingSession): void {
    this.cancelAttachDeadline(session);
    session.attachDeadline = setTimeout(() => {
      session.attachDeadline = null;
      if (session.status !== 'recording' && session.status !== 'paused') return;
      // 超过恢复期限：收尾并保存已识别内容。
      void this.finalize(session, 'disconnect_timeout');
    }, ATTACH_DEADLINE_MS);
    session.attachDeadline.unref?.();
  }

  private cancelAttachDeadline(session: RecordingSession): void {
    if (session.attachDeadline) {
      clearTimeout(session.attachDeadline);
      session.attachDeadline = null;
    }
  }

  // ---- 生命周期 ----------------------------------------------------------

  /** 启动时把上次进程遗留的活动录音标为异常终止，保留已有转写。 */
  async markOrphanedSessions(): Promise<void> {
    try {
      const count = await MeetingMinutes.update(
        { status: 'failed', endReason: 'process_restart', endedAt: new Date() },
        { where: { status: { [Op.in]: ['recording', 'paused'] } } },
      );
      if (count[0] > 0) console.warn('meeting_minutes_orphaned_marked', { count: count[0] });
      // 进程重启遗留的纪要 generating 状态：允许重试。
      await MeetingMinutes.update(
        { summaryStatus: 'failed', summaryError: 'process_restart' },
        { where: { summaryStatus: 'generating' } },
      );
    } catch (error) {
      console.error('meeting_minutes_orphan_mark_failed', { type: (error as Error)?.message });
    }
  }

  /** 关停：等待所有会话完成保存与 ASR 释放。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeRevocation?.();
    this.unsubscribeRevocation = null;
    const pending = [...this.sessions.values()].map((session) => this.finalize(session, 'server_shutdown'));
    await Promise.allSettled(pending);
  }
}

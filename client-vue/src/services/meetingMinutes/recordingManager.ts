import { AudioChunkQueue, type RawAudioChunk } from './audioChunkQueue';
import { LIMITS, PHASE, isActivePhase, type Phase } from './constants';
import { RecordingError, normalizeRecordingError } from './recordingError';
import type { MeetingMinutesSocket, MinutesErrorMessage, MinutesTranscriptMessage } from './socketClient';

/** 音频层接口：Manager 只依赖此接口，便于测试替换。 */
export interface MinutesAudioInput {
  /** 准备输入（获取麦克风、建 AudioContext、挂 worklet）。失败抛错。 */
  prepare(): Promise<void>;
  /** 暂停采集，等待 worklet 尾片确认。 */
  pause(): Promise<void>;
  /** 恢复采集。 */
  resume(): Promise<void>;
  /** 重建输入（暂停曾失败或设备丢失后）。 */
  rebuild(): Promise<void>;
  /** 使进行中的 prepare 失效。 */
  cancelPending(): void;
  /** 释放所有资源；返回释放过程中的错误（如有）。 */
  dispose(): Promise<Error | null>;
  readonly isReady: boolean;
  /** 暂停曾失败（尾片超时）标记；为 true 时恢复需重建输入。 */
  readonly pauseError: boolean;
}

export interface RecordingManagerOptions {
  createAudio: (handlers: AudioHandlers) => MinutesAudioInput;
  createSocket: (handlers: SocketHandlers) => MinutesTransport;
  /** 每次录音使用新的传输层实例；复用实例可能导致监听残留。 */
  newSocket: (handlers: SocketHandlers) => MinutesTransport;
  limits?: Partial<typeof LIMITS>;
}

interface AudioHandlers {
  onChunk: (chunk: RawAudioChunk) => void;
  onVolume: (data: { volume: number; waveList: number[] }) => void;
  onFault: (error: RecordingError) => void;
}

type MinutesTransport = Pick<MeetingMinutesSocket, 'isOpen' | 'connect' | 'request' | 'chunk' | 'close'>;

export interface SocketHandlers {
  onTranscript: (message: MinutesTranscriptMessage) => void;
  onSessionError: (message: MinutesErrorMessage) => void;
  onDisconnected: (error: RecordingError) => void;
  onAuthFailure: (error: RecordingError) => void;
}

export interface RecordingSnapshot {
  phase: Phase;
  reason: string;
  issue: { type: string; message: string; suggestion: string } | null;
  sessionId: string;
  startedAt: number;
  /** 服务端已确认的录音秒数（去重样本累计）。 */
  seconds: number;
  /** 服务端已确认的最后一片序号（-1 表示尚无）。 */
  lastAcceptedAudioIndex: number;
  /** 本地已产出（含未确认）的分片数。 */
  producedChunks: number;
  /** 待发送（未交给传输层）分片数。 */
  pendingChunks: number;
  /** 已发送未确认的分片数。 */
  inFlightChunks: number;
}

export interface RecordingManagerListeners {
  status?: (snapshot: RecordingSnapshot) => void;
  volume?: (data: { volume: number; waveList: number[] }) => void;
  transcript?: (message: unknown) => void;
  sessionError?: (message: unknown) => void;
  issue?: (error: RecordingError) => void;
  ended?: (snapshot: RecordingSnapshot) => void;
}

const isRecoverableConnectionError = (error: RecordingError): boolean =>
  ['SOCKET_CLOSED', 'SOCKET_CONNECT_FAILED', 'SOCKET_READY_TIMEOUT'].includes(error.type);

function serverErrorToRecordingError(code: string | undefined, detail?: unknown): RecordingError {
  switch (code) {
    case 'ASR_UNAVAILABLE':
      return new RecordingError('SOCKET_REJECTED', { code, detail }, 'asr-unavailable');
    case 'SESSION_NOT_FOUND':
      return new RecordingError('SOCKET_REJECTED', { code, detail }, 'session-gone');
    case 'SESSION_ACTIVE':
      return new RecordingError('INVALID_OPERATION', { code, detail });
    case 'FORBIDDEN':
      return new RecordingError('SOCKET_AUTH_FAILED', { code, detail });
    default:
      return new RecordingError('SOCKET_REJECTED', { code, detail });
  }
}

function ackCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: string } } | null)?.cause;
  return cause?.code;
}

/**
 * 会议录音状态机与流程编排（唯一业务状态来源）。
 *
 * 关键不变式：
 * - sessionId 由服务端 start 发放；后续所有操作携带并校验归属；
 * - 开始与恢复都等服务端 ACK 后才采集/补发；
 * - 结束优先于恢复；end 已发未确认进入 END_UNCONFIRMED，禁止 resume；
 * - 音频仅删除服务端已确认分片；在途/待发送超限时自动暂停（背压）；
 * - 断线保留队列与 ASR 会话资格，attach 恢复；手动暂停不被自动恢复；
 * - dispose 幂等，集中释放麦克风、AudioContext、Socket 与定时器。
 */
export class RecordingManager {
  private readonly createAudio: RecordingManagerOptions['createAudio'];
  private readonly newSocket: RecordingManagerOptions['newSocket'];
  private readonly limits: typeof LIMITS;
  private listeners: RecordingManagerListeners = {};

  private phase: Phase = PHASE.IDLE;
  private reason = '';
  private issue: RecordingSnapshot['issue'] = null;
  private sessionId = '';
  private startedAt = 0;
  private confirmedSamples = 0;
  private lastAcceptedAudioIndex = -1;
  private producedChunks = 0;
  private queue = new AudioChunkQueue(LIMITS.timesliceMs);
  private operation = 0;
  private audio: MinutesAudioInput | null = null;
  private socket: MinutesTransport | null = null;
  private startPromise: Promise<RecordingSnapshot> | null = null;
  private pausePromise: Promise<RecordingSnapshot | false> | null = null;
  private recoveryPromise: Promise<RecordingSnapshot | false> | null = null;
  private stopPromise: Promise<RecordingSnapshot | false> | null = null;
  private disposed = false;
  private userPaused = false;
  private retryWaiter: { timer: ReturnType<typeof setTimeout>; resolve: () => void } | null = null;
  private pauseTimer: ReturnType<typeof setInterval> | null = null;
  private pauseStartedAt = 0;
  private attemptedPauseDeadline = 0;
  private silentCount = 0;
  /** 音频确认等待中，避免并发 flush。 */
  private flushPromise: Promise<void> | null = null;
  private endSent = false;
  private endConfirmed = false;

  constructor(options: RecordingManagerOptions) {
    this.createAudio = options.createAudio;
    this.newSocket = options.newSocket ?? options.createSocket;
    this.limits = { ...LIMITS, ...options.limits };
  }

  setListeners(listeners: RecordingManagerListeners): void {
    this.listeners = listeners;
  }

  getState(): RecordingSnapshot {
    return {
      phase: this.phase,
      reason: this.reason,
      issue: this.issue,
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      seconds: Math.floor(this.confirmedSamples / this.limits.sampleRate),
      lastAcceptedAudioIndex: this.lastAcceptedAudioIndex,
      producedChunks: this.producedChunks,
      pendingChunks: this.queue.pendingCount,
      inFlightChunks: this.queue.inFlightCount,
    };
  }

  private publish(): RecordingSnapshot {
    const snapshot = this.getState();
    this.listeners.status?.(snapshot);
    return snapshot;
  }

  private transition(phase: Phase, reason = ''): RecordingSnapshot {
    this.phase = phase;
    this.reason = reason;
    this.syncPauseTimer();
    return this.publish();
  }

  private report(error: RecordingError): void {
    this.issue = { type: error.type, message: error.message, suggestion: error.suggestion };
    this.publish();
    this.listeners.issue?.(error);
  }

  private assertOperation(operation: number): void {
    if (operation !== this.operation) throw new RecordingError('CANCELLED');
    if (this.disposed) throw new RecordingError('CANCELLED');
  }

  /** 开始录音：先建连认证，再由服务端创建会话，成功后才输出音频。 */
  start(): Promise<RecordingSnapshot> {
    if (this.startPromise) return this.startPromise;
    if (isActivePhase(this.phase)) return Promise.reject(new RecordingError('INVALID_OPERATION'));
    if (this.disposed) return Promise.reject(new RecordingError('CANCELLED'));
    const operation = ++this.operation;
    this.sessionId = '';
    this.startedAt = Date.now();
    this.confirmedSamples = 0;
    this.lastAcceptedAudioIndex = -1;
    this.producedChunks = 0;
    this.queue = new AudioChunkQueue(this.limits.timesliceMs);
    this.userPaused = false;
    this.silentCount = 0;
    this.endSent = false;
    this.endConfirmed = false;
    this.issue = null;
    this.audio = this.createAudio({
      onChunk: (chunk) => {
        if (this.disposed) return;
        this.handleChunk(chunk);
      },
      onVolume: (data) => {
        if (this.disposed) return;
        this.listeners.volume?.(data);
      },
      onFault: (error) => {
        if (this.disposed) return;
        this.handleAudioFault(error);
      },
    });
    this.transition(PHASE.STARTING);
    const promise = this.finishStart(operation).finally(() => {
      if (this.startPromise === promise) this.startPromise = null;
    });
    this.startPromise = promise;
    return promise;
  }

  private async finishStart(operation: number): Promise<RecordingSnapshot> {
    try {
      const socket = this.newSocket(this.socketHandlers());
      this.socket = socket;
      await socket.connect();
      this.assertOperation(operation);
      await this.audio!.prepare();
      this.assertOperation(operation);
      // start 不携带 sessionId；服务端创建并返回。
      const ack = await socket.request('minutes_start', {});
      this.assertOperation(operation);
      const serverSessionId = typeof ack.sessionId === 'string' ? ack.sessionId : '';
      if (!serverSessionId) throw new RecordingError('SOCKET_REJECTED', { detail: ack });
      this.sessionId = serverSessionId;
      await this.audio!.resume();
      this.assertOperation(operation);
      this.transition(PHASE.RECORDING);
      return this.getState();
    } catch (cause) {
      if (operation !== this.operation || this.disposed) throw new RecordingError('CANCELLED', cause);
      const error = normalizeRecordingError(cause, 'AUDIO_FAILED', 'starting');
      await this.releaseResources();
      this.transition(PHASE.IDLE);
      this.report(error);
      throw error;
    }
  }

  private socketHandlers(): SocketHandlers {
    return {
      onTranscript: (message) => {
        if (this.disposed) return;
        this.listeners.transcript?.(message);
      },
      onSessionError: (message) => {
        if (this.disposed) return;
        if (message.sessionId !== this.sessionId) return;
        if (message.error === 'ASR_FAULT' && this.phase === PHASE.RECORDING) {
          void this.pause('asr-fault');
        }
        this.listeners.sessionError?.(message);
      },
      onDisconnected: (error) => {
        if (this.disposed) return;
        this.handleConnectionFault(error);
      },
      onAuthFailure: (error) => {
        if (this.disposed) return;
        this.handleAuthFailure(error);
      },
    };
  }

  private handleChunk(chunk: RawAudioChunk): void {
    if (!isActivePhase(this.phase) || this.disposed) return;
    if (this.phase !== PHASE.RECORDING && this.phase !== PHASE.STOPPING && !this.pausePromise) return;
    this.producedChunks += 1;
    this.queue.enqueue(chunk);
    this.silentCount = chunk.isSilent ? this.silentCount + 1 : 0;
    this.publish();
    void this.flushAudio().catch((cause) => {
      if (this.phase !== PHASE.RECORDING) return;
      const code = ackCode(cause);
      if (code === 'ASR_FAULT' || code === 'SEND_FAILED') {
        void this.pause(code === 'ASR_FAULT' ? 'asr-fault' : 'send-blocked');
        this.report(new RecordingError('SEND_BLOCKED'));
      } else {
        this.handleConnectionFault(normalizeRecordingError(cause, 'SOCKET_CLOSED'));
      }
    });
    if (this.confirmedSamples / this.limits.sampleRate * 1000 >= this.limits.recordingMs) {
      void this.stop('recording-limit').catch(() => undefined);
      return;
    }
    if (this.phase !== PHASE.RECORDING) return;
    const blocked =
      this.queue.pendingCount * this.limits.timesliceMs >= this.limits.pendingMs ||
      this.queue.inFlightCount >= this.limits.inFlight;
    if (blocked) {
      void this.pause('send-blocked').then((result) => {
        if (result && this.phase === PHASE.PAUSED) this.report(new RecordingError('SEND_BLOCKED'));
      });
    } else if (this.silentCount >= this.limits.silentChunks) {
      void this.pause('silent-input').then((result) => {
        if (result && this.phase === PHASE.PAUSED) this.report(new RecordingError('SILENT_INPUT'));
      });
    }
  }

  /**
   * 单在途发送循环：逐个发送队首，等确认 Promise 后才发下一片。
   * 不轮询；确认由 chunk Promise 的 then 链驱动。
   */
  private flushAudio(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    const socket = this.socket;
    const sessionId = this.sessionId;
    const pending = (async () => {
      while (!this.disposed && !this.endConfirmed && this.socket === socket) {
        const head = this.queue.pending[0];
        if (!head) return;
        if (!socket?.isOpen || !sessionId) throw new RecordingError('SOCKET_CLOSED');
        this.queue.sendHead(() => true);
        try {
          const ack = await socket.chunk(sessionId, head);
          if (this.disposed || this.socket !== socket) return;
          if (ack.lastAcceptedAudioIndex < head.audioIndex) throw new RecordingError('SEND_FAILED');
          this.confirmChunk(ack);
        } catch (error) {
          this.queue.retryUnconfirmed();
          throw error;
        }
      }
    })().finally(() => {
      if (this.flushPromise === pending) this.flushPromise = null;
    });
    this.flushPromise = pending;
    return pending;
  }

  /** 应用服务端累计确认：收缩队列并更新已确认时长。 */
  private confirmChunk(ack: { lastAcceptedAudioIndex: number; acceptedSamples?: number }): void {
    if (ack.lastAcceptedAudioIndex > this.lastAcceptedAudioIndex) {
      this.lastAcceptedAudioIndex = ack.lastAcceptedAudioIndex;
    }
    this.queue.confirmThrough(this.lastAcceptedAudioIndex);
    if (typeof ack.acceptedSamples === 'number') {
      this.confirmedSamples = Math.max(this.confirmedSamples, ack.acceptedSamples);
    }
    this.publish();
  }

  pause(reason = 'user'): Promise<RecordingSnapshot | false> {
    if (this.pausePromise) return this.pausePromise;
    if (this.phase !== PHASE.RECORDING) return Promise.resolve(this.getState());
    if (this.disposed) return Promise.resolve(false);
    const operation = this.operation;
    this.userPaused = true;
    this.silentCount = 0;
    if (!this.pauseStartedAt) this.pauseStartedAt = Date.now();
    this.transition(PHASE.PAUSED, reason);
    const promise = this.audio!
      .pause()
      .then(async () => {
        if (operation !== this.operation) return this.getState();
        if (this.socket?.isOpen && this.sessionId) {
          try {
            await this.flushAudio().catch(() => undefined);
            if (operation === this.operation) {
              await this.socket?.request('minutes_pause', { sessionId: this.sessionId });
            }
          } catch {
            /* 暂停通知失败不阻断；音频已停，队列保留 */
          }
        }
        return this.getState();
      })
      .catch((cause) => {
        if (operation === this.operation) this.report(normalizeRecordingError(cause, 'AUDIO_FAILED'));
        return false as const;
      })
      .finally(() => {
        if (this.pausePromise === promise) this.pausePromise = null;
      });
    this.pausePromise = promise;
    return promise;
  }

  /** 用户继续录音；连接可用时直接恢复，不可用则先恢复连接再 attach。 */
  resume(): Promise<RecordingSnapshot | false> {
    if (this.phase === PHASE.END_UNCONFIRMED) {
      this.report(new RecordingError('END_UNCONFIRMED'));
      return Promise.resolve(false);
    }
    if (this.recoveryPromise) return this.recoveryPromise;
    if (this.phase !== PHASE.PAUSED) return Promise.resolve(false);
    if (this.pauseExpired()) return this.stop('pause-limit');
    return this.recover('resume');
  }

  private handleConnectionFault(error: RecordingError): void {
    if (this.disposed || error.type === 'CANCELLED') return;
    if ((this.phase === PHASE.RECORDING || this.phase === PHASE.PAUSED)) {
      void this.recover('network').catch(() => undefined);
    }
  }

  private handleAuthFailure(error: RecordingError): void {
    if (this.disposed) return;
    if (this.phase === PHASE.IDLE) {
      // 连接阶段的认证失败由 start 的 catch 处理。
      return;
    }
    if (this.stopPromise) return;
    // 会话撤销/退出登录：终止恢复资格，停止采集并暂停，保留已确认内容。
    // 不自动重连；用户可结束保存或放弃。
    this.userPaused = true;
    if (!this.pauseStartedAt) this.pauseStartedAt = Date.now();
    void this.audio?.pause().catch(() => undefined);
    this.transition(PHASE.PAUSED, 'auth-failed');
    this.report(error);
  }

  private handleAudioFault(error: RecordingError): void {
    if (this.disposed) return;
    if ((this.phase === PHASE.RECORDING || this.phase === PHASE.PAUSED)) {
      void this.recover('input').catch(() => undefined);
    } else if (this.phase === PHASE.STARTING) {
      this.report(error);
    }
  }

  /** 恢复连接并重新绑定会话（attach）；保留未确认队列。 */
  private recover(reason: string): Promise<RecordingSnapshot | false> {
    if (this.recoveryPromise) return this.recoveryPromise;
    if (this.stopPromise || this.disposed) return Promise.resolve(false);
    const operation = ++this.operation;
    this.issue = null;
    this.transition(PHASE.RECOVERING, reason);
    const promise = this.finishRecovery(operation, reason).finally(() => {
      if (this.recoveryPromise === promise) this.recoveryPromise = null;
    });
    this.recoveryPromise = promise;
    return promise;
  }

  private async finishRecovery(operation: number, reason: string): Promise<RecordingSnapshot | false> {
    let attempts = 0;
    try {
      // 尾片曾超时后用户明确继续：重建损坏输入。
      if (reason === 'resume' && this.audio!.pauseError) await this.audio!.rebuild();
      else await this.audio!.pause();
      this.assertOperation(operation);
      const wantRecording = reason === 'resume' || !this.userPaused;
      while (operation === this.operation && !this.disposed) {
        try {
          if (!this.audio!.isReady) await this.audio!.rebuild();
          this.assertOperation(operation);
          this.socket?.close();
          await this.flushPromise?.catch(() => undefined);
          this.assertOperation(operation);
          this.queue.retryUnconfirmed();
          this.socket = this.newSocket(this.socketHandlers());
          await this.socket.connect();
          this.assertOperation(operation);
          const ack = await this.socket.request('minutes_attach', { sessionId: this.sessionId });
          this.assertOperation(operation);
          const status = typeof ack.status === 'string' ? ack.status : '';
          if (typeof ack.lastAcceptedAudioIndex === 'number') {
            this.lastAcceptedAudioIndex = Math.max(this.lastAcceptedAudioIndex, ack.lastAcceptedAudioIndex);
            this.queue.confirmThrough(this.lastAcceptedAudioIndex);
          }
          if (typeof ack.acceptedSamples === 'number') {
            this.confirmedSamples = Math.max(this.confirmedSamples, ack.acceptedSamples);
          }
          if (status === 'ended' || status === 'failed' || status === 'finalizing') {
            await this.releaseResources();
            return this.transition(PHASE.ENDED, 'server-ended');
          }
          // 手动暂停的录音恢复连接后仍保持暂停。
          if (status === 'paused' && !wantRecording) {
            this.issue = null;
            this.transition(PHASE.PAUSED, 'user');
            return this.getState();
          }
          // 恢复录音前必须先让服务端确认 resume，再恢复采集。
          if (wantRecording) {
            await this.socket.request('minutes_resume', { sessionId: this.sessionId });
            this.assertOperation(operation);
          }
          await this.flushAudio();
          this.assertOperation(operation);
          if (wantRecording) {
            await this.audio!.resume();
            this.assertOperation(operation);
            this.userPaused = false;
            this.pauseStartedAt = 0;
          }
          this.issue = null;
          this.transition(wantRecording ? PHASE.RECORDING : PHASE.PAUSED, wantRecording ? '' : 'user');
          return this.getState();
        } catch (cause) {
          if (this.disposed) return false;
          if (operation !== this.operation) return false;
          const code = ackCode(cause);
          if (code === 'SESSION_NOT_FOUND' || code === 'FORBIDDEN') {
            // 服务端已收尾或撤销：本地放弃，展示已保存内容。
            this.pauseStartedAt ||= Date.now();
            this.transition(PHASE.PAUSED, 'session-gone');
            this.report(serverErrorToRecordingError(code, (cause as { cause?: unknown })?.cause));
            return false;
          }
          const error = normalizeRecordingError(cause, 'AUDIO_FAILED');
          if (!isRecoverableConnectionError(error)) throw error;
          await this.audio!.pause().catch(() => undefined);
          this.assertOperation(operation);
          this.socket?.close();
          this.transition(PHASE.RECOVERING, 'network');
          await this.waitRetry(Math.min(++attempts * 1000, 5000));
          this.assertOperation(operation);
        }
      }
      return false;
    } catch (cause) {
      if (operation !== this.operation || this.disposed) return false;
      this.pauseStartedAt ||= Date.now();
      this.transition(PHASE.PAUSED, 'recovery-failed');
      this.report(normalizeRecordingError(cause, 'AUDIO_FAILED'));
      return false;
    }
  }

  private waitRetry(delay: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.retryWaiter = null;
        resolve();
      }, delay);
      this.retryWaiter = { timer, resolve };
    });
  }

  private cancelRetry(): void {
    if (!this.retryWaiter) return;
    clearTimeout(this.retryWaiter.timer);
    this.retryWaiter.resolve();
    this.retryWaiter = null;
  }

  /** 正常结束：尾片 → 补发 → end ACK → 服务端收尾 → 本地释放。 */
  stop(reason = 'user'): Promise<RecordingSnapshot | false> {
    if (this.stopPromise) return this.stopPromise;
    if (!isActivePhase(this.phase) || this.disposed) return Promise.resolve(this.getState());
    ++this.operation;
    this.recoveryPromise = null;
    this.pausePromise = null;
    this.cancelRetry();
    this.userPaused = false;
    this.issue = null;
    this.transition(PHASE.STOPPING, reason);
    const promise = Promise.resolve()
      .then(() => this.finishStop(reason))
      .finally(() => {
        if (this.stopPromise === promise) this.stopPromise = null;
      });
    this.stopPromise = promise;
    return promise;
  }

  private async finishStop(reason: string): Promise<RecordingSnapshot | false> {
    const sessionId = this.sessionId;
    try {
      await this.audio!.pause().catch(() => undefined);
      if (!this.socket?.isOpen) {
        this.socket?.close();
        await this.flushPromise?.catch(() => undefined);
        this.queue.retryUnconfirmed();
        this.socket = this.newSocket(this.socketHandlers());
        await this.socket.connect();
        // 已发送 end 的重试可以直接读服务端保存结果，无需再次绑定。
        if (!this.endSent && this.queue.pendingCount > 0) {
          const attached = await this.socket.request('minutes_attach', { sessionId });
          if (typeof attached.lastAcceptedAudioIndex === 'number') {
            this.confirmChunk({ lastAcceptedAudioIndex: attached.lastAcceptedAudioIndex });
          }
        }
      }
      if (!this.endSent) {
        try {
          await this.flushAudio();
        } catch (error) {
          if (ackCode(error) !== 'ASR_FAULT') throw error;
          // ASR 已不可用时仍允许保存已确认的文字和转写不完整状态。
        }
      }
      this.endSent = true;
      const ack = await this.socket!.request('minutes_end', { sessionId, lastAudioIndex: this.lastAcceptedAudioIndex }, this.limits.endMs);
      if (typeof ack.durationSeconds === 'number') {
        this.confirmedSamples = Math.max(this.confirmedSamples, Math.round(ack.durationSeconds * this.limits.sampleRate));
      }
      this.endConfirmed = true;
      const pending = this.queue.discard();
      const cleanupError = await this.releaseResources();
      const result = this.transition(PHASE.ENDED, reason);
      if (cleanupError) this.report(new RecordingError('CLEANUP_FAILED', cleanupError));
      if (ack.transcriptComplete === false) this.report(new RecordingError('TRANSCRIPT_INCOMPLETE'));
      else if (pending > 0) this.report(new RecordingError('UNSENT_AUDIO'));
      this.listeners.ended?.(result);
      return result;
    } catch (cause) {
      if (this.disposed) return false;
      this.pauseStartedAt ||= Date.now();
      const rejected = cause instanceof RecordingError && cause.type === 'SOCKET_REJECTED';
      if (rejected) this.endSent = false;
      this.transition(this.endSent ? PHASE.END_UNCONFIRMED : PHASE.PAUSED, 'end-failed');
      this.report(
        this.endSent ? new RecordingError('END_UNCONFIRMED', cause) : rejected ? new RecordingError('END_REJECTED', cause) : normalizeRecordingError(cause, 'AUDIO_FAILED'),
      );
      return false;
    }
  }

  /** 本地放弃：释放资源、丢弃未确认队列，不通知服务端（断线期限后由服务端收尾）。 */
  cancelReconnect(): Promise<RecordingSnapshot | false> {
    if (this.stopPromise) return this.stopPromise;
    if (!isActivePhase(this.phase) || this.disposed) return Promise.resolve(this.getState());
    ++this.operation;
    this.recoveryPromise = null;
    this.pausePromise = null;
    this.cancelRetry();
    this.transition(PHASE.STOPPING, 'discard');
    const promise = Promise.resolve()
      .then(async () => {
        this.queue.discard();
        await this.releaseResources();
        return this.transition(PHASE.ENDED, 'discard');
      })
      .finally(() => {
        if (this.stopPromise === promise) this.stopPromise = null;
      });
    this.stopPromise = promise;
    return promise;
  }

  /**
   * 幂等的统一销毁：取消进行中的操作，释放麦克风、AudioContext、Socket 与定时器。
   * 页面返回、路由离开、退出登录和组件卸载都走这一出口。
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    ++this.operation;
    this.recoveryPromise = null;
    this.pausePromise = null;
    this.startPromise = null;
    this.stopPromise = null;
    this.cancelRetry();
    const socket = this.socket;
    const audio = this.audio;
    this.socket = null;
    this.audio = null;
    this.queue.discard();
    if (this.pauseTimer) {
      clearInterval(this.pauseTimer);
      this.pauseTimer = null;
    }
    socket?.close(new RecordingError('CANCELLED'));
    await audio?.dispose().catch(() => undefined);
  }

  private async releaseResources(): Promise<Error | null> {
    if (this.pauseTimer) {
      clearInterval(this.pauseTimer);
      this.pauseTimer = null;
    }
    this.cancelRetry();
    const socket = this.socket;
    const audio = this.audio;
    this.socket = null;
    this.audio = null;
    socket?.close(new RecordingError('CANCELLED'));
    if (!audio) return null;
    try {
      return await audio.dispose();
    } catch (error) {
      return error instanceof Error ? error : new RecordingError('CLEANUP_FAILED', error);
    }
  }

  private pauseExpired(): boolean {
    return this.pauseStartedAt > 0 && Date.now() - this.pauseStartedAt >= this.limits.pauseMs;
  }

  private syncPauseTimer(): void {
    if (this.pauseTimer) {
      clearInterval(this.pauseTimer);
      this.pauseTimer = null;
    }
    if ((this.phase !== PHASE.PAUSED && this.phase !== PHASE.RECOVERING) || !this.pauseStartedAt) return;
    this.pauseTimer = setInterval(() => {
      const deadline = this.pauseStartedAt + this.limits.pauseMs;
      if (Date.now() >= deadline && deadline !== this.attemptedPauseDeadline) {
        this.attemptedPauseDeadline = deadline;
        void this.stop('pause-limit').catch(() => undefined);
      }
    }, 1000);
    this.pauseTimer.unref?.();
  }
}

import { io, type Socket } from 'socket.io-client';
import { LIMITS } from './constants';
import { RecordingError } from './recordingError';
import type { QueuedAudioChunk } from './audioChunkQueue';

/**
 * 控制请求 ACK（emit + callback）。
 * 每个事件的形状见 docs/MEETING_RECORDING_PROTOCOL.md。
 */
export type MinutesAck = Record<string, unknown> & {
  ok?: boolean;
  error?: string;
};

/** 服务端推送的转写消息。 */
export interface MinutesTranscriptMessage {
  sessionId: string;
  segments: Array<{
    segmentId: number;
    text: string;
    isFinal: boolean;
    startMs: number;
    endMs: number | null;
    speakerId: string | null;
  }>;
}

/** 服务端推送的会话级错误（可恢复，如 ASR 故障）。 */
export interface MinutesErrorMessage {
  sessionId: string;
  error: string;
  message?: string;
}

export interface MeetingMinutesSocketOptions {
  /** 获取当前登录 token；握手认证时调用。 */
  getToken: () => string | null;
  /** 服务端报告 token 过期时调用；成功则允许用新 token 重连。 */
  onTokenExpired: () => Promise<boolean>;
  /** 会话级推送（转写增量）。 */
  onTranscript: (message: MinutesTranscriptMessage) => void;
  /** 会话级推送（可恢复错误）。 */
  onSessionError: (message: MinutesErrorMessage) => void;
  /** 连接断开（含认证失败/拒绝），Manager 决定恢复或终止。 */
  onDisconnected: (error: RecordingError) => void;
  /** 认证失败（非过期）等终止条件。 */
  onAuthFailure: (error: RecordingError) => void;
}

interface PendingRequest {
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 会议实时记录的 Socket.IO 传输层。
 *
 * 职责边界：建连（握手认证）、控制请求-ACK、二进制音频发送、推送转发、关闭。
 * 不做自动重连决策、不重发 end —— 这些由 RecordingManager 决定。
 *
 * 注意：`/meeting-minutes` 是 Socket.IO 的 path（HTTP 升级路径），不是 namespace。
 * 固定 WebSocket transport，避免 polling 降级后二进制走 Base64。
 */
export class MeetingMinutesSocket {
  private readonly url: string;
  private readonly getToken: () => string | null;
  private readonly onTokenExpired: () => Promise<boolean>;
  private readonly onTranscript: (message: MinutesTranscriptMessage) => void;
  private readonly onSessionError: (message: MinutesErrorMessage) => void;
  private readonly onDisconnected: (error: RecordingError) => void;
  private readonly onAuthFailure: (error: RecordingError) => void;

  private socket: Socket | null = null;
  private connecting: Promise<void> | null = null;
  private cancelConnect: ((error: Error) => void) | null = null;
  private readonly pendingRequests = new Map<(...args: unknown[]) => void, PendingRequest>();
  private closedByUs = false;
  private authFailed = false;

  constructor(options: MeetingMinutesSocketOptions & { url?: string }) {
    this.url = options.url ?? window.location.origin;
    this.getToken = options.getToken;
    this.onTokenExpired = options.onTokenExpired;
    this.onTranscript = options.onTranscript;
    this.onSessionError = options.onSessionError;
    this.onDisconnected = options.onDisconnected;
    this.onAuthFailure = options.onAuthFailure;
  }

  get isOpen(): boolean {
    return this.socket?.connected === true;
  }

  /** 建立经握手的连接（幂等）；认证成功后 resolve，失败/超时/取消必须 settle。 */
  connect(): Promise<void> {
    if (this.isOpen) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.closedByUs = false;
    if (this.authFailed) return Promise.reject(new RecordingError('SOCKET_AUTH_FAILED'));

    const socket = io(this.url, {
      path: '/meeting-minutes',
      transports: ['websocket'],
      reconnection: false,
      timeout: LIMITS.requestMs,
      auth: { token: this.getToken() ?? '' },
    });
    this.socket = socket;

    const promise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        this.cancelConnect = null;
        socket.removeListener('connect', onConnect);
        socket.removeListener('connect_error', onConnectError);
        if (error) reject(error);
        else resolve();
      };
      const onConnect = () => settle();
      const onConnectError = (error: Error) => {
        const message = error.message ?? '';
        if (message === 'token_expired') {
          this.socket = null;
          socket.removeAllListeners();
          socket.disconnect();
          // 复用现有 token 刷新能力；刷新成功后由 Manager 重连，失败则终止。
          this.onTokenExpired().catch(() => false).then((refreshed) => {
            if (settled) return;
            if (!refreshed) this.onAuthFailure(new RecordingError('SOCKET_AUTH_EXPIRED'));
            settle(new RecordingError(refreshed ? 'SOCKET_CONNECT_FAILED' : 'SOCKET_AUTH_EXPIRED'));
          });
          return;
        }
        // 会话撤销、退出登录等终止条件：不重连。
        if (message === 'auth_failed') {
          this.authFailed = true;
          this.onAuthFailure(new RecordingError('SOCKET_AUTH_FAILED'));
          this.socket = null;
          socket.removeAllListeners();
          socket.disconnect();
          settle(new RecordingError('SOCKET_AUTH_FAILED'));
          return;
        }
        settle(new RecordingError('SOCKET_CONNECT_FAILED', error));
      };
      socket.once('connect', onConnect);
      socket.once('connect_error', onConnectError);
      this.cancelConnect = settle;
    });

    socket.on('disconnect', () => {
      const wasUs = this.closedByUs || this.socket !== socket;
      if (!wasUs) this.rejectPending(new RecordingError('SOCKET_CLOSED'));
      if (!wasUs && !this.authFailed) this.onDisconnected(new RecordingError('SOCKET_CLOSED'));
    });
    socket.on('minutes_transcript', (raw: unknown) => {
      const message = raw as MinutesTranscriptMessage;
      if (message && typeof message.sessionId === 'string' && Array.isArray(message.segments)) {
        this.onTranscript(message);
      }
    });
    socket.on('minutes_error', (raw: unknown) => {
      const message = raw as MinutesErrorMessage;
      if (message && typeof message.sessionId === 'string' && typeof message.error === 'string') {
        this.onSessionError(message);
      }
    });

    const connecting = promise.finally(() => {
      if (this.connecting === connecting) this.connecting = null;
    });
    this.connecting = connecting;
    return connecting;
  }

  /**
   * 发送一个控制请求，等待 ACK callback。
   * @param event minutes_start | minutes_attach | minutes_pause | minutes_resume | minutes_end
   * @param payload 不含 sessionId 之外的身份字段；身份只来自握手。
   */
  request(event: string, payload: Record<string, unknown> = {}, timeoutMs: number = LIMITS.requestMs): Promise<MinutesAck> {
    if (!this.isOpen) return Promise.reject(new RecordingError('SOCKET_CLOSED'));
    return new Promise<MinutesAck>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(callback);
        // 超时不能确定服务端是否处理，关闭旧连接避免迟到 ACK 污染下一次请求。
        const error = new RecordingError('SOCKET_READY_TIMEOUT');
        reject(error);
        this.close(error);
      }, timeoutMs);
      const callback = (ack: unknown) => {
        clearTimeout(timer);
        this.pendingRequests.delete(callback);
        const data = (ack ?? {}) as MinutesAck;
        if (data.ok === false) {
          reject(new RecordingError('SOCKET_REJECTED', { code: data.error, detail: data }));
        } else {
          resolve(data);
        }
      };
      this.pendingRequests.set(callback, { reject, timer });
      this.socket!.emit(event, payload, callback);
    });
  }

  /**
   * 发送一个音频分片（元数据 + 二进制），等待确认。
   * ACK 统一为 { sessionId, lastAcceptedAudioIndex, acceptedSamples }。
   * @returns 已交给传输层并挂上确认回调 resolve 确认值；连接不可用 reject。
   */
  chunk(
    sessionId: string,
    chunk: QueuedAudioChunk,
  ): Promise<{ sessionId: string; lastAcceptedAudioIndex: number; acceptedSamples: number }> {
    if (!this.isOpen) return Promise.reject(new RecordingError('SOCKET_CLOSED'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(callback);
        // 超时不主动关连接：音频确认超时应保留队列由 Manager 决策（暂停/重连）。
        reject(new RecordingError('SOCKET_READY_TIMEOUT'));
      }, LIMITS.requestMs);
      const callback = (ack: unknown) => {
        clearTimeout(timer);
        this.pendingRequests.delete(callback);
        const data = (ack ?? {}) as {
          sessionId?: string;
          lastAcceptedAudioIndex?: number;
          acceptedSamples?: number;
          error?: string;
          expectedAudioIndex?: number;
        };
        if (
          data &&
          data.expectedAudioIndex === undefined &&
          data.sessionId === sessionId &&
          typeof data.lastAcceptedAudioIndex === 'number'
        ) {
          resolve({
            sessionId: data.sessionId,
            lastAcceptedAudioIndex: data.lastAcceptedAudioIndex,
            acceptedSamples: typeof data.acceptedSamples === 'number' ? data.acceptedSamples : 0,
          });
        } else {
          reject(new RecordingError('SOCKET_REJECTED', { code: data.error, detail: ack }));
        }
      };
      this.pendingRequests.set(callback, { reject, timer });
      this.socket!.emit('minutes_audio', { sessionId, audioIndex: chunk.audioIndex }, chunk.pcm, callback);
    });
  }

  private rejectPending(error: Error): void {
    for (const waiter of this.pendingRequests.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pendingRequests.clear();
  }

  /** 主动关闭；未完成的请求以传入错误结束。 */
  close(error: Error = new RecordingError('CANCELLED')): void {
    this.closedByUs = true;
    this.cancelConnect?.(error);
    this.rejectPending(error);
    const socket = this.socket;
    this.socket = null;
    this.connecting = null;
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
    }
  }

  /** 主动关闭标记，供 Manager 区分用户关闭与故障断开。 */
  get closedByClient(): boolean {
    return this.closedByUs;
  }
}

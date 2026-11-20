/**
 * 实时语音识别客户端（腾讯云 + sherpa-onnx 双后端）。
 *
 * 后端选择优先级：
 * 1. 腾讯云实时语音识别（TENCENT_ASR_APP_ID / SECRET_ID / SECRET_KEY 三项齐全时）；
 * 2. sherpa-onnx 自部署容器（MEETINGS_ASR_URL 配置时）；
 * 3. 都未配置 → available=false，上层拒绝开始录音。
 *
 * 两种后端对上层暴露统一的 AsrSessionHandle（sendPcm / finish / close），
 * 内部各自适配协议差异。会话服务不感知具体后端。
 *
 * 腾讯云协议：https://cloud.tencent.com/document/api/1093/48982
 * - wss://asr.cloud.tencent.com/asr/v2/<appid>，HMAC-SHA1 签名
 * - 二进制 PCM；slice_type=2 确认句，顶层 final=1 确认整条流结束
 *
 * sherpa-onnx 协议（与 deploy/asr/sherpa_asr_server.py 对齐）：
 * - 二进制 PCM16LE 帧；JSON { segmentId, text, isFinal, startMs, endMs, speakerId }
 * - 结束：{"is_speaking": false} → 服务端回 isInputDone
 */
import { createHmac, randomInt, randomUUID } from 'crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { env } from '../config/env';

export interface AsrTimedWord {
  text: string;
  startMs: number;
  endMs: number;
}

/** 统一转写片段（协议见 docs/MEETING_RECORDING_PROTOCOL.md）。 */
export interface AsrTranscriptSegment {
  segmentId: number;
  text: string;
  isFinal: boolean;
  startMs: number;
  endMs: number | null;
  speakerId: string | null;
  words?: AsrTimedWord[];
}

export interface AsrSessionHandle {
  /** 发送 PCM16LE 帧；已关闭时抛错，由调用方标记故障。 */
  sendPcm(pcm: Buffer): Promise<void>;
  /** 通知音频结束；等待最终结果（或本端超时）后 resolve。 */
  finish(): Promise<void>;
  /** 关闭连接，释放资源。 */
  close(): void;
}

interface AsrListener {
  onSegment: (segment: AsrTranscriptSegment) => void;
  onFault: (error: Error) => void;
}

const CONNECT_TIMEOUT_MS = 10_000;
/** finish 后等待最终结果的超时。 */
const FINISH_TIMEOUT_MS = 20_000;
/** 等待 ASR 发送队列的有界时长。 */
const SEND_QUEUE_TIMEOUT_MS = 30_000;
/** 单会话 ASR 发送积压上限（片）。 */
const MAX_SEND_BACKLOG = 200;

// ---- 类型判断 -------------------------------------------------------------

function getWebSocketCtor(): typeof WebSocket | undefined {
  return (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
}

// ---- 腾讯云 ASR ------------------------------------------------------------

const TENCENT_ASR_HOST = 'asr.cloud.tencent.com';
const PCM_BYTES_PER_MS = 32; // 16 kHz × 2 字节 / 1000
const TENCENT_FRAME_BYTES = 6400;
const TENCENT_WORD_TIMING_ENGINES = new Set([
  '8k_en', '8k_zh', '8k_zh_finance', '8k_zh_large', '16k_zh_en',
  '16k_zh', '16k_en', '16k_ca', '16k_zh-TW', '16k_ja',
]);

function tencentUrl(appId: string, secretId: string, secretKey: string, engine: string, voiceId: string) {
  const now = Math.floor(Date.now() / 1000);
  const params = new URLSearchParams({
    engine_model_type: engine,
    expired: String(now + 300),
    needvad: '1',
    nonce: String(randomInt(1, 1_000_000_000)),
    secretid: secretId,
    timestamp: String(now),
    voice_format: '1',
    voice_id: voiceId,
  });
  if (TENCENT_WORD_TIMING_ENGINES.has(engine)) params.set('word_info', '1');
  params.sort();
  const path = `${TENCENT_ASR_HOST}/asr/v2/${appId}?${params}`;
  const signature = createHmac('sha1', secretKey).update(path).digest('base64');
  return `wss://${path}&signature=${encodeURIComponent(signature)}`;
}

interface TencentMessage {
  code: number;
  voice_id?: string;
  final?: number;
  result?: {
    index: number;
    voice_text_str: string;
    slice_type: number;
    start_time: number;
    end_time: number;
    word_list?: { word: string; start_time: number; end_time: number }[];
  };
}

function validTimedWords(words: AsrTimedWord[]): AsrTimedWord[] | undefined {
  const timed = words.filter((word) => word && typeof word.text === 'string' && word.text.trim()
    && Number.isFinite(word.startMs) && Number.isFinite(word.endMs)
    && word.startMs >= 0 && word.endMs > word.startMs);
  return timed.length ? timed : undefined;
}

function createTencentSession(
  appId: string,
  secretId: string,
  secretKey: string,
  engine: string,
  listener: AsrListener,
): Promise<AsrSessionHandle> {
  const WebSocketCtor = getWebSocketCtor();
  if (!WebSocketCtor) return Promise.reject(new Error('ASR_NOT_AVAILABLE'));

  const voiceId = randomUUID();
  let socket: WebSocket;
  try {
    socket = new WebSocketCtor(tencentUrl(appId, secretId, secretKey, engine, voiceId));
  } catch {
    return Promise.reject(new Error('ASR_CONNECT_FAILED'));
  }
  const lifetime = new AbortController();
  let state: 'connecting' | 'open' | 'finishing' | 'finished' | 'closed' = 'connecting';
  let nextSendAt = 0;
  let finishPromise: Promise<void> | undefined;
  let settleFinish: ((error?: Error) => void) | undefined;

  return new Promise<AsrSessionHandle>((resolve, reject) => {
    const connectTimer = setTimeout(() => close(new Error('ASR_CONNECT_TIMEOUT')), CONNECT_TIMEOUT_MS);

    function close(error?: Error) {
      if (state === 'closed') return;
      const previous = state;
      state = 'closed';
      lifetime.abort();
      clearTimeout(connectTimer);
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
      const reason = error ?? new Error('ASR_CLOSED');
      if (previous === 'connecting') reject(reason);
      if (previous === 'finishing') settleFinish?.(reason);
      // 初始化失败通过 open 报错，已在收尾的故障通过 finish 报错。
      if (previous === 'open' && error) listener.onFault(error);
    }

    function finish(): Promise<void> {
      if (finishPromise) return finishPromise;
      if (state !== 'open') return Promise.reject(new Error('ASR_CLOSED'));
      if (nextSendAt === 0) {
        close();
        return (finishPromise = Promise.resolve());
      }
      state = 'finishing';
      finishPromise = new Promise<void>((resolveFinish, rejectFinish) => {
        const timer = setTimeout(() => close(new Error('ASR_FINISH_TIMEOUT')), FINISH_TIMEOUT_MS);
        settleFinish = (error) => {
          clearTimeout(timer);
          settleFinish = undefined;
          if (error) rejectFinish(error);
          else resolveFinish();
        };
        // 给最后一片音频留出它的播放时长，之后才发结束帧。
        void (async () => {
          try {
            await delay(Math.max(0, Math.ceil(nextSendAt - performance.now())), undefined, {
              signal: lifetime.signal,
            });
            socket.send(JSON.stringify({ type: 'end' }));
          } catch {
            close(new Error('ASR_SEND_FAILED'));
          }
        })();
      });
      return finishPromise;
    }

    const handle: AsrSessionHandle = {
      async sendPcm(pcm) {
        for (let offset = 0; offset < pcm.length; offset += TENCENT_FRAME_BYTES) {
          if (state !== 'open') throw new Error('ASR_CLOSED');
          const waitMs = Math.ceil(nextSendAt - performance.now());
          if (waitMs > 0) await delay(waitMs, undefined, { signal: lifetime.signal });
          if (state !== 'open' || socket.readyState !== WebSocketCtor.OPEN) throw new Error('ASR_CLOSED');
          const frame = pcm.subarray(offset, offset + TENCENT_FRAME_BYTES);
          try {
            socket.send(frame);
          } catch {
            throw new Error('ASR_SEND_FAILED');
          }
          nextSendAt = performance.now() + frame.length / PCM_BYTES_PER_MS;
        }
      },
      finish,
      close,
    };

    socket.onerror = () => close(new Error(state === 'connecting' ? 'ASR_CONNECT_FAILED' : 'ASR_CLOSED'));
    socket.onclose = () => close(new Error('ASR_CLOSED'));
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      let message: TencentMessage | null;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message || !Number.isInteger(message.code)) return;
      if (message.code !== 0) {
        close(new Error(`TENCENT_ASR_ERROR_${message.code}`));
        return;
      }
      if (state === 'connecting') {
        if (message.voice_id === voiceId && !message.result) {
          clearTimeout(connectTimer);
          state = 'open';
          resolve(handle);
        }
        return;
      }
      if (state !== 'open' && state !== 'finishing') return;
      const result = message.result;
      if (result && Number.isSafeInteger(result.index) && typeof result.voice_text_str === 'string') {
        const isFinal = result.slice_type === 2;
        const words = isFinal && Array.isArray(result.word_list)
          ? validTimedWords(result.word_list.filter(Boolean).map((word) => ({
              text: word.word, startMs: word.start_time, endMs: word.end_time,
            })))
          : undefined;
        listener.onSegment({
          segmentId: result.index,
          text: result.voice_text_str,
          isFinal,
          startMs: result.start_time,
          endMs: isFinal ? result.end_time : null,
          speakerId: null,
          ...(words && { words }),
        });
      }
      if (state === 'finishing' && message.final === 1) {
        state = 'finished';
        settleFinish?.();
        close();
      }
    };
  });
}

// ---- sherpa-onnx ASR ------------------------------------------------------

interface SegmentMessage {
  segmentId?: number;
  text?: string;
  isFinal?: boolean;
  startMs?: number;
  endMs?: number | null;
  speakerId?: string | null;
  words?: AsrTimedWord[];
}

function parseSegment(raw: string): AsrTranscriptSegment | null {
  let message: SegmentMessage;
  try {
    message = JSON.parse(raw) as SegmentMessage;
  } catch {
    return null;
  }
  if (typeof message.text !== 'string') return null;
  const words = message.isFinal && Array.isArray(message.words) ? validTimedWords(message.words) : undefined;
  return {
    segmentId: typeof message.segmentId === 'number' ? message.segmentId : 0,
    text: message.text,
    isFinal: Boolean(message.isFinal),
    startMs: typeof message.startMs === 'number' ? message.startMs : 0,
    endMs: typeof message.endMs === 'number' ? message.endMs : null,
    speakerId: typeof message.speakerId === 'string' ? message.speakerId : null,
    ...(words && { words }),
  };
}

function createSherpaSession(url: string, listener: AsrListener): Promise<AsrSessionHandle> {
  const WebSocketCtor = getWebSocketCtor();
  if (!WebSocketCtor) return Promise.reject(new Error('ASR_NOT_AVAILABLE'));

  const socket = new WebSocketCtor(url, 'binary');
  let closed = false;
  let failed = false;
  let finished = false;
  let finishSettled = false;

  const fail = (error: Error) => {
    if (failed || closed) return;
    failed = true;
    listener.onFault(error);
  };

  const connectTimer = setTimeout(() => {
    fail(new Error('ASR_CONNECT_TIMEOUT'));
    socket.close();
  }, CONNECT_TIMEOUT_MS);

  const connectWaiters: Array<() => void> = [];
  let openResolve: (() => void) | null = null;
  let openReject: ((e: Error) => void) | null = null;
  const openPromise = new Promise<void>((resolve, reject) => {
    openResolve = resolve;
    openReject = reject;
  });

  socket.onopen = () => {
    clearTimeout(connectTimer);
    openResolve?.();
    for (const waiter of connectWaiters.splice(0)) waiter();
  };
  socket.onerror = () => {
    clearTimeout(connectTimer);
    const error = new Error('ASR_CONNECT_FAILED');
    openReject?.(error);
    for (const waiter of connectWaiters.splice(0)) waiter();
    fail(error);
  };
  socket.onclose = () => {
    clearTimeout(connectTimer);
    closed = true;
    if (!failed) fail(new Error('ASR_CLOSED'));
    openReject?.(new Error('ASR_CLOSED'));
    for (const waiter of connectWaiters.splice(0)) waiter();
  };
  socket.onmessage = (event: MessageEvent) => {
    if (typeof event.data !== 'string') return;
    const segment = parseSegment(event.data);
    if (segment) listener.onSegment(segment);
  };

  const doOpen = openPromise.catch((error: Error) => {
    socket.close();
    throw error;
  });

  let sendChain: Promise<void> = Promise.resolve();
  let sendBacklog = 0;

  return doOpen.then(() => ({
    async sendPcm(pcm: Buffer) {
      if (closed || failed) throw new Error('ASR_CLOSED');
      if (socket.readyState !== WebSocketCtor.OPEN) throw new Error('ASR_CLOSED');
      if (sendBacklog >= MAX_SEND_BACKLOG) throw new Error('ASR_SEND_BACKLOG_FULL');
      sendBacklog += 1;
      const send = new Promise<void>((resolve) => {
        try {
          socket.send(pcm);
          resolve();
        } catch (error) {
          fail(error instanceof Error ? error : new Error('ASR_SEND_FAILED'));
          resolve();
        }
      }).finally(() => {
        sendBacklog = Math.max(0, sendBacklog - 1);
      });
      const queued = sendChain.catch(() => undefined).then(() => send);
      sendChain = queued.catch(() => undefined);
      await Promise.race([
        queued,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, SEND_QUEUE_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
      if (failed) throw new Error('ASR_CLOSED');
    },
    finish() {
      if (closed || failed) return Promise.reject(new Error('ASR_CLOSED'));
      if (socket.readyState !== WebSocketCtor.OPEN) return Promise.reject(new Error('ASR_CLOSED'));
      if (finished) return Promise.resolve();
      finished = true;
      return new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (ok: boolean, error?: Error) => {
          if (settled) return;
          settled = true;
          finishSettled = true;
          clearTimeout(timer);
          if (ok) resolve();
          else reject(error ?? new Error('ASR_FINISH_TIMEOUT'));
        };
        const timer = setTimeout(() => settle(false, new Error('ASR_FINISH_TIMEOUT')), FINISH_TIMEOUT_MS);
        timer.unref?.();
        const previousMessage = socket.onmessage;
        socket.onmessage = (event: MessageEvent) => {
          previousMessage?.call(socket, event);
          if (typeof event.data !== 'string') return;
          try {
            const msg = JSON.parse(event.data) as { isInputDone?: boolean };
            if (msg.isInputDone) settle(true);
          } catch {
            /* ignore */
          }
        };
        const previousClose = socket.onclose;
        socket.onclose = (event) => {
          settle(finishSettled, new Error('ASR_CLOSED'));
          previousClose?.call(socket, event);
        };
        try {
          socket.send(JSON.stringify({ is_speaking: false }));
        } catch {
          settle(false, new Error('ASR_SEND_FAILED'));
        }
      });
    },
    close() {
      closed = true;
      fail(new Error('ASR_CLOSED'));
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
    },
  }));
}

// ---- 统一入口 -------------------------------------------------------------

/** 后端类型标识。 */
export type AsrBackend = 'tencent' | 'sherpa' | 'none';

export class AsrClient {
  /** 当前可用的后端类型。 */
  readonly backend: AsrBackend;
  readonly available: boolean;
  private readonly sherpaUrl: string | null;
  private readonly tencent: { appId: string; secretId: string; secretKey: string; engine: string };

  constructor() {
    const tencent = env.meetings.tencent;
    const sherpaUrl = env.meetings.asrUrl;
    const hasTencent = Boolean(tencent.appId && tencent.secretId && tencent.secretKey);

    if (hasTencent) {
      this.backend = 'tencent';
      this.available = true;
      this.tencent = { appId: tencent.appId, secretId: tencent.secretId, secretKey: tencent.secretKey, engine: tencent.engine };
      this.sherpaUrl = null;
    } else if (sherpaUrl) {
      this.backend = 'sherpa';
      this.available = true;
      this.tencent = { appId: '', secretId: '', secretKey: '', engine: '' };
      this.sherpaUrl = sherpaUrl;
    } else {
      this.backend = 'none';
      this.available = false;
      this.tencent = { appId: '', secretId: '', secretKey: '', engine: '' };
      this.sherpaUrl = null;
    }
  }

  /** 建立一个 ASR 会话；未配置或连接失败时抛错（调用方清理资源）。 */
  async open(listener: AsrListener): Promise<AsrSessionHandle> {
    if (!this.available) throw new Error('ASR_NOT_CONFIGURED');
    if (this.backend === 'tencent') {
      return createTencentSession(
        this.tencent.appId,
        this.tencent.secretId,
        this.tencent.secretKey,
        this.tencent.engine,
        listener,
      );
    }
    return createSherpaSession(this.sherpaUrl!, listener);
  }
}

/** 兼容旧导出名。 */
export const SherpaAsrClient = AsrClient;
export const sherpaAsrClient = new AsrClient();

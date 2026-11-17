import type { RawAudioChunk } from '@/services/meetingMinutes/audioChunkQueue';
import { describe, expect, it, vi } from 'vitest';
import {
  RecordingManager,
  type MinutesAudioInput,
} from '@/services/meetingMinutes/recordingManager';
import type {
  MeetingMinutesSocket,
  MinutesErrorMessage,
  MinutesTranscriptMessage,
} from '@/services/meetingMinutes/socketClient';
import { RecordingError } from '@/services/meetingMinutes/recordingError';
import { PHASE } from '@/services/meetingMinutes/constants';

/** 可控的 mock 音频层。 */
function createMockAudio(handlers: {
  onChunk: (c: RawAudioChunk) => void;
  onVolume: (d: { volume: number; waveList: number[] }) => void;
  onFault: (e: RecordingError) => void;
}): MinutesAudioInput & {
  emitChunk: (partial?: Partial<RawAudioChunk>) => void;
  failPause: () => void;
  failResume: () => void;
  loseDevice: () => void;
  disposeError: Error | null;
  disposed: boolean;
} {
  let ready = false;
  let pauseShouldFail = false;
  let resumeShouldFail = false;
  const mock = {
    disposeError: null as Error | null,
    disposed: false,
    get isReady() {
      return ready;
    },
    get pauseError() {
      return pauseShouldFail;
    },
    prepare: vi.fn(async () => {
      ready = true;
    }),
    pause: vi.fn(async () => {
      if (pauseShouldFail) throw new Error('worklet timeout');
    }),
    resume: vi.fn(async () => {
      if (resumeShouldFail) throw new Error('resume failed');
    }),
    rebuild: vi.fn(async () => {
      ready = false;
      await mock.prepare();
    }),
    cancelPending: vi.fn(),
    dispose: vi.fn(async () => {
      mock.disposed = true;
      return mock.disposeError;
    }),
    emitChunk: (partial?: Partial<RawAudioChunk>) =>
      handlers.onChunk({
        pcm: new ArrayBuffer(6400),
        sampleCount: 3200,
        energy: 0.01,
        isSilent: false,
        ...partial,
      }),
    failPause: () => {
      pauseShouldFail = true;
    },
    failResume: () => {
      resumeShouldFail = true;
    },
    loseDevice: () => handlers.onFault(new RecordingError('MIC_DEVICE_LOST')),
  };
  return mock;
}

interface SocketBehavior {
  startResult?: Record<string, unknown>;
  attachResult?: Record<string, unknown>;
  endResult?: Record<string, unknown>;
  rejectStart?: boolean;
  rejectAttachWith?: string;
  rejectEndWith?: 'throw' | 'reject';
  failOnConnect?: boolean;
  failChunkWith?: 'throw' | null;
  /** 音频 ACK 行为：lastAcceptedAudioIndex 跟随或滞后。 */
  lagAcks?: number;
  /** 手动触发 onDisconnected（模拟断线）。 */
  fault?: () => void;
}

/** 可控的 mock socket 层（新协议：握手后 connect、request 事件名、chunk 返回确认）。 */
function createMockSocket(handlers: {
  onTranscript: (m: MinutesTranscriptMessage) => void;
  onSessionError: (m: MinutesErrorMessage) => void;
  onDisconnected: (e: RecordingError) => void;
  onAuthFailure: (e: RecordingError) => void;
}): Pick<MeetingMinutesSocket, 'isOpen' | 'connect' | 'request' | 'chunk' | 'close'> & {
  behavior: SocketBehavior;
  requests: Array<{ event: string; payload: Record<string, unknown> }>;
  simulateDisconnect: () => void;
  sendTranscript: (segments: MinutesTranscriptMessage['segments']) => void;
} {
  let open = false;
  const behavior: SocketBehavior = {};
  const requests: Array<{ event: string; payload: Record<string, unknown> }> = [];
  let acceptedIndex = -1;
  let acceptedSamples = 0;
  const mock = {
    behavior,
    requests,
    get isOpen() {
      return open;
    },
    connect: vi.fn(async () => {
      if (behavior.failOnConnect) throw new RecordingError('SOCKET_CONNECT_FAILED');
      open = true;
    }),
    request: vi.fn(async (event: string, payload: Record<string, unknown> = {}) => {
      requests.push({ event, payload });
      if (event === 'minutes_start') {
        if (behavior.rejectStart) throw new RecordingError('SOCKET_REJECTED');
        return { ok: true, sessionId: 'server-session-1', ...(behavior.startResult ?? {}) };
      }
      if (event === 'minutes_attach') {
        if (behavior.rejectAttachWith) {
          const error = new RecordingError('SOCKET_REJECTED');
          (error as { cause?: { code?: string } }).cause = { code: behavior.rejectAttachWith };
          throw error;
        }
        const result = behavior.attachResult ?? {
          ok: true,
          status: 'recording',
          lastAcceptedAudioIndex: acceptedIndex,
          acceptedSamples,
        };
        if (typeof result.lastAcceptedAudioIndex === 'number') {
          acceptedIndex = result.lastAcceptedAudioIndex;
          if (typeof result.acceptedSamples === 'number') acceptedSamples = result.acceptedSamples;
        }
        return result;
      }
      if (event === 'minutes_pause' || event === 'minutes_resume') {
        return { ok: true, lastAcceptedAudioIndex: acceptedIndex };
      }
      if (event === 'minutes_end') {
        if (behavior.rejectEndWith === 'throw') throw new Error('end failed');
        if (behavior.rejectEndWith === 'reject') throw new RecordingError('SOCKET_REJECTED');
        const durationSeconds = Math.floor(acceptedSamples / 16000);
        return { ok: true, durationSeconds, transcriptComplete: true, ...(behavior.endResult ?? {}) };
      }
      throw new RecordingError('INVALID_OPERATION');
    }),
    chunk: vi.fn(
      (sessionId: string, chunk: { audioIndex: number; sampleCount: number }) =>
        new Promise<{ sessionId: string; lastAcceptedAudioIndex: number; acceptedSamples: number }>(
          (resolve, reject) => {
            if (behavior.failChunkWith === 'throw') {
              reject(new RecordingError('SOCKET_CLOSED'));
              return;
            }
            const lag = behavior.lagAcks ?? 0;
            const target = lag > 0 ? chunk.audioIndex - lag : chunk.audioIndex;
            if (target > acceptedIndex) {
              acceptedIndex = target;
              acceptedSamples += chunk.sampleCount;
            }
            if (!open) {
              reject(new RecordingError('SOCKET_CLOSED'));
              return;
            }
            resolve({ sessionId, lastAcceptedAudioIndex: acceptedIndex, acceptedSamples });
          },
        ),
    ),
    close: vi.fn(() => {
      open = false;
    }),
    simulateDisconnect: () => {
      open = false;
      handlers.onDisconnected(new RecordingError('SOCKET_CLOSED'));
    },
    sendTranscript: (segments: MinutesTranscriptMessage['segments']) =>
      handlers.onTranscript({ sessionId: 'server-session-1', segments }),
  };
  return mock;
}

function createManager(opts: {
  socketOverrides?: Partial<SocketBehavior>;
  limits?: {
    inFlight?: number;
    pendingMs?: number;
    silentChunks?: number;
    recordingMs?: number;
    pauseMs?: number;
    requestMs?: number;
    endMs?: number;
    timesliceMs?: number;
  };
} = {}) {
  let audio!: ReturnType<typeof createMockAudio>;
  const sockets: Array<ReturnType<typeof createMockSocket>> = [];
  const manager = new RecordingManager({
    createAudio: (handlers) => {
      audio = createMockAudio(handlers);
      return audio;
    },
    createSocket: (handlers) => {
      const socket = createMockSocket(handlers);
      Object.assign(socket.behavior, opts.socketOverrides ?? {});
      sockets.push(socket);
      return socket;
    },
    newSocket: (handlers) => {
      const socket = createMockSocket(handlers);
      Object.assign(socket.behavior, opts.socketOverrides ?? {});
      sockets.push(socket);
      return socket;
    },
    limits: {
      requestMs: 50,
      workletMs: 50,
      recordingMs: 1_000_000,
      pauseMs: 60_000,
      inFlight: 5,
      pendingMs: 30_000,
      silentChunks: 10,
      ...(opts.limits ?? {}),
    } as never,
  });
  return { manager, getAudio: () => audio, getSockets: () => sockets, getSocket: () => sockets[sockets.length - 1]! };
}

const tickMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 发射分片并等待其被服务端确认（lastAcceptedAudioIndex 追上）。 */
async function emitUntilConfirmed(manager: RecordingManager, audio: ReturnType<typeof createMockAudio>, count = 1) {
  for (let i = 0; i < count; i++) {
    audio.emitChunk();
  }
  for (let i = 0; i < 100 && manager.getState().lastAcceptedAudioIndex < count - 1; i++) {
    await tickMs(10);
  }
}

describe('RecordingManager（新协议）', () => {
  it('开始录音：idle → starting → recording；sessionId 来自服务端 start ACK', async () => {
    const { manager, getAudio, getSocket } = createManager();
    const phases: string[] = [];
    manager.setListeners({ status: (s) => phases.push(s.phase) });
    const snapshot = await manager.start();
    expect(snapshot.phase).toBe(PHASE.RECORDING);
    // start 请求不携带 sessionId
    expect(getSocket().requests.find((r) => r.event === 'minutes_start')?.payload).toEqual({});
    expect(snapshot.sessionId).toBe('server-session-1');
    expect(getAudio().resume).toHaveBeenCalled();
    expect(phases).toEqual(['starting', 'recording']);
  });

  it('开始失败（connect 失败）释放资源回到 idle', async () => {
    const { manager, getAudio } = createManager({ socketOverrides: { failOnConnect: true } });
    await expect(manager.start()).rejects.toMatchObject({ type: 'SOCKET_CONNECT_FAILED' });
    expect(manager.getState().phase).toBe(PHASE.IDLE);
    expect(getAudio().dispose).toHaveBeenCalled();
  });

  it('start 被服务端拒绝（ASR 不可用）回到 idle 并报告错误', async () => {
    const { manager } = createManager({ socketOverrides: { rejectStart: true } });
    manager.setListeners({});
    await expect(manager.start()).rejects.toMatchObject({ type: 'SOCKET_REJECTED' });
    expect(manager.getState().phase).toBe(PHASE.IDLE);
  });

  it('录音中分片：仅删除已确认分片，时长按服务端确认样本累计', async () => {
    const { manager, getAudio, getSocket } = createManager();
    await manager.start();
    await emitUntilConfirmed(manager, getAudio(), 5);
    expect(getSocket().chunk).toHaveBeenCalledTimes(5);
    expect(manager.getState().lastAcceptedAudioIndex).toBe(4);
    // 5 片 × 3200 样本 @16k = 1 秒
    expect(manager.getState().seconds).toBe(1);
    expect(manager.getState().inFlightChunks).toBe(0);
  });

  it('手动暂停：recording → paused，并发送 minutes_pause', async () => {
    const { manager, getSocket } = createManager();
    await manager.start();
    await manager.pause('user');
    expect(manager.getState().phase).toBe(PHASE.PAUSED);
    expect(manager.getState().reason).toBe('user');
    expect(getSocket().requests.some((r) => r.event === 'minutes_pause')).toBe(true);
  });

  it('恢复：paused → recording，attach 携带服务端 sessionId，再发 minutes_resume', async () => {
    const { manager, getSocket } = createManager();
    await manager.start();
    await manager.pause('user');
    await manager.resume();
    expect(manager.getState().phase).toBe(PHASE.RECORDING);
    const attach = getSocket().requests.find((r) => r.event === 'minutes_attach');
    expect(attach?.payload).toEqual({ sessionId: 'server-session-1' });
    const resume = getSocket().requests.find((r) => r.event === 'minutes_resume');
    expect(resume?.payload).toEqual({ sessionId: 'server-session-1' });
  });

  it('attach 返回 paused（手动暂停）时保持暂停，不被自动恢复', async () => {
    const { manager, getSocket } = createManager({
      socketOverrides: {
        attachResult: { ok: true, status: 'paused', lastAcceptedAudioIndex: 0, acceptedSamples: 1600 },
      },
    });
    await manager.start();
    await manager.pause('user');
    getSocket().simulateDisconnect();
    await vi.waitFor(() => expect(manager.getState().phase).toBe(PHASE.PAUSED));
    expect(getSocket().requests.some((r) => r.event === 'minutes_resume')).toBe(false);
  });

  it('断线自动恢复：recording → recovering → recording，先补发未确认再采集', async () => {
    const { manager, getSocket } = createManager();
    await manager.start();
    getSocket().simulateDisconnect();
    await tickMs(30);
    expect(manager.getState().phase).toBe(PHASE.RECORDING);
    expect(getSocket().requests.some((r) => r.event === 'minutes_attach')).toBe(true);
  });

  it('attach 返回 SESSION_NOT_FOUND 时进入 paused(session-gone)，不再重试', async () => {
    const { manager, getSocket } = createManager({ socketOverrides: { rejectAttachWith: 'SESSION_NOT_FOUND' } });
    await manager.start();
    getSocket().simulateDisconnect();
    await tickMs(30);
    expect(manager.getState().phase).toBe(PHASE.PAUSED);
    expect(manager.getState().reason).toBe('session-gone');
  });

  it('手动结束：recording → stopping → ended，end 携带 lastAudioIndex 并释放资源', async () => {
    const { manager, getAudio, getSocket } = createManager();
    await manager.start();
    await emitUntilConfirmed(manager, getAudio(), 3);
    const result = await manager.stop('user');
    expect(result && result.phase).toBe(PHASE.ENDED);
    const end = getSocket().requests.find((r) => r.event === 'minutes_end');
    expect(end?.payload).toEqual({ sessionId: 'server-session-1', lastAudioIndex: 2 });
    expect(getAudio().dispose).toHaveBeenCalled();
  });

  it('end 明确拒绝回到 paused(end-failed) 并报告 END_REJECTED', async () => {
    const { manager } = createManager({ socketOverrides: { rejectEndWith: 'reject' } });
    const issues: string[] = [];
    manager.setListeners({ issue: (e) => issues.push(e.type) });
    await manager.start();
    const result = await manager.stop('user');
    expect(result).toBe(false);
    expect(manager.getState().phase).toBe(PHASE.PAUSED);
    expect(issues).toContain('END_REJECTED');
  });

  it('end 已发送但未确认（抛错）进入 end-unconfirmed，禁止 resume', async () => {
    const { manager } = createManager({ socketOverrides: { rejectEndWith: 'throw' } });
    await manager.start();
    await manager.stop('user');
    expect(manager.getState().phase).toBe(PHASE.END_UNCONFIRMED);
    const resumed = await manager.resume();
    expect(resumed).toBe(false);
  });

  it('待发送音频达到 pendingMs 上限自动暂停（send-blocked 背压）', async () => {
    const { manager, getAudio } = createManager({
      socketOverrides: { lagAcks: 999 }, // ACK 永不追上 → 全部积压
      limits: { pendingMs: 800, inFlight: 10 },
    });
    const issues: string[] = [];
    manager.setListeners({ issue: (e) => issues.push(e.type) });
    await manager.start();
    // 200ms/片，发 6 片 = 1200ms > 800ms 上限
    for (let i = 0; i < 6; i++) getAudio().emitChunk();
    await tickMs(100);
    expect(manager.getState().phase).toBe(PHASE.PAUSED);
    expect(manager.getState().reason).toBe('send-blocked');
  });

  it('连续全零分片达到阈值自动暂停（silent-input，设备无信号）', async () => {
    const { manager, getAudio } = createManager({ limits: { silentChunks: 3 } });
    await manager.start();
    for (let i = 0; i < 3; i++) getAudio().emitChunk({ isSilent: true });
    await tickMs(50);
    expect(manager.getState().phase).toBe(PHASE.PAUSED);
    expect(manager.getState().reason).toBe('silent-input');
  });

  it('能量极低的非全零分片不触发静音暂停（正常停顿与轻噪音不暂停）', async () => {
    const { manager, getAudio } = createManager({ limits: { silentChunks: 3 } });
    await manager.start();
    for (let i = 0; i < 5; i++) getAudio().emitChunk({ energy: 1e-8, isSilent: false });
    await tickMs(50);
    expect(manager.getState().phase).toBe(PHASE.RECORDING);
  });

  it('cancelReconnect 本地放弃：丢弃未确认分片，不发 end', async () => {
    const { manager, getSocket } = createManager();
    await manager.start();
    await manager.cancelReconnect();
    expect(manager.getState().phase).toBe(PHASE.ENDED);
    expect(manager.getState().reason).toBe('discard');
    expect(getSocket().requests.some((r) => r.event === 'minutes_end')).toBe(false);
  });

  it('active 状态下重复 start 返回 INVALID_OPERATION', async () => {
    const { manager } = createManager();
    await manager.start();
    await expect(manager.start()).rejects.toMatchObject({ type: 'INVALID_OPERATION' });
  });

  it('转写消息透传给 listeners.transcript', async () => {
    const { manager, getSocket } = createManager();
    const messages: unknown[] = [];
    manager.setListeners({ transcript: (m) => messages.push(m) });
    await manager.start();
    getSocket().sendTranscript([
      { segmentId: 1, text: '你好', isFinal: true, startMs: 0, endMs: 500, speakerId: null },
    ]);
    expect(messages).toHaveLength(1);
  });

  it('dispose 幂等：二次调用不抛错，资源只释放一次', async () => {
    const { manager, getAudio } = createManager();
    await manager.start();
    await manager.dispose();
    await expect(manager.dispose()).resolves.toBeUndefined();
    expect(getAudio().dispose).toHaveBeenCalledTimes(1);
  });

  it('dispose 后 start 被拒绝', async () => {
    const { manager } = createManager();
    await manager.dispose();
    await expect(manager.start()).rejects.toMatchObject({ type: 'CANCELLED' });
  });
});

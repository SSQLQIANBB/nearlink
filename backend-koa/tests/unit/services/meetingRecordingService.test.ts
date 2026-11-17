import type { Socket } from 'socket.io';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AsrClient } from '../../../src/services/asrClient';
import { MeetingRecordingService } from '../../../src/services/meetingRecordingService';

const models = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }));
vi.mock('../../../src/models/MeetingMinutes', () => ({ MeetingMinutes: models }));
vi.mock('../../../src/services/loginSessionService', () => ({ onLoginSessionsRevoked: vi.fn() }));

const user = { userId: 1, sid: 'test-login' } as Parameters<MeetingRecordingService['start']>[1];

function fixture() {
  const streams: Array<{
    listener: Parameters<AsrClient['open']>[0];
    frameSent: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  const open: AsrClient['open'] = async (listener) => {
    const stream = { listener, frameSent: vi.fn(), close: vi.fn() };
    streams.push(stream);
    const text = `第${streams.length}句`;
    return {
      async sendPcm() {
        stream.frameSent();
      },
      async finish() {
        if (stream.frameSent.mock.calls.length) {
          listener.onSegment({ segmentId: 0, text, isFinal: true, startMs: 0, endMs: 200, speakerId: null });
        }
      },
      close: stream.close,
    };
  };
  const socket = { id: 'test-socket', emit: vi.fn() } as unknown as Socket;
  return { streams, socket, service: new MeetingRecordingService({ asr: { backend: 'tencent', open } }) };
}

describe('ASR 上游切换后仍使用同一会议会话', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    models.update.mockResolvedValue([1]);
  });

  it('暂停收尾、继续时重新连接，新流从序号 0 开始也能保存两句', async () => {
    const { service, socket, streams } = fixture();
    const started = await service.start(socket, user);
    if (!started.ok) throw new Error('start failed');
    const { sessionId } = started;
    expect(service.onAudio(socket, user, sessionId, 0, Buffer.alloc(6400))).toMatchObject({ acceptedSamples: 3200 });
    await service.pause(socket, user, sessionId);
    await vi.waitFor(() => expect(streams[0].close).toHaveBeenCalledOnce());
    expect(streams).toHaveLength(1);
    await service.resume(socket, user, sessionId);
    service.onAudio(socket, user, sessionId, 1, Buffer.alloc(6400));
    expect(await service.end(socket, user, sessionId, 1)).toMatchObject({ ok: true, transcriptComplete: true });
    const persisted = models.update.mock.lastCall?.[0];
    expect(persisted.transcript).toBe('第1句\n第2句');
    expect(JSON.parse(persisted.transcriptJson)).toMatchObject([
      { segmentId: 0, startMs: 0, endMs: 200 },
      { segmentId: 1, startMs: 200, endMs: 400 },
    ]);
  });

  it('意外断流后可以继续，但保存时仍明确标记转写不完整', async () => {
    const { service, socket, streams } = fixture();
    const started = await service.start(socket, user);
    if (!started.ok) throw new Error('start failed');
    const { sessionId } = started;
    service.onAudio(socket, user, sessionId, 0, Buffer.alloc(6400));
    await vi.waitFor(() => expect(streams[0].frameSent).toHaveBeenCalledOnce());
    streams[0].listener.onFault(new Error('ASR_CLOSED'));
    service.onAudio(socket, user, sessionId, 1, Buffer.alloc(6400));
    expect(await service.end(socket, user, sessionId, 1)).toMatchObject({ ok: true, transcriptComplete: false });
    expect(models.update.mock.lastCall?.[0]).toMatchObject({ status: 'failed', transcript: '第2句' });
  });
});

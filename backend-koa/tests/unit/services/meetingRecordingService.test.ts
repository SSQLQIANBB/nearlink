import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Socket } from 'socket.io';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AsrClient } from '../../../src/services/asrClient';
import { MeetingRecordingService } from '../../../src/services/meetingRecordingService';
import { MeetingAudioStore } from '../../../src/services/meetingAudioStore';
import type { QiniuStorageScope } from '../../../src/services/qiniuStorageService';
import { generateMeetingSummary } from '../../../src/services/llmMinutesService';

const models = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  findOne: vi.fn(),
  findAll: vi.fn(),
}));
vi.mock('../../../src/models/MeetingMinutes', () => ({
  MeetingMinutes: models,
  isValidSessionId: (v: unknown) => typeof v === 'string' && v.length > 0,
}));
vi.mock('../../../src/services/loginSessionService', () => ({ onLoginSessionsRevoked: vi.fn() }));
vi.mock('../../../src/services/llmMinutesService', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/services/llmMinutesService')>(),
  generateMeetingSummary: vi.fn(),
}));

const user = { userId: 1, sid: 'test-login' } as Parameters<MeetingRecordingService['start']>[1];

let stagingRoot: string;
let store: MeetingAudioStore;

beforeAll(async () => {
  stagingRoot = await mkdtemp(path.join(tmpdir(), 'meeting-audio-test-'));
  const memoryStorage = {
    uploaded: [] as Array<{ key: string; scope: QiniuStorageScope }>,
    async uploadFile(_file: string, key: string, scope: QiniuStorageScope = 'private') {
      memoryStorage.uploaded.push({ key, scope });
      return { key, scope, storageRef: `qiniu://${scope}/${key}`, fileUrl: `https://private.test/${key}` };
    },
    resolveUrl(ref: string) {
      return `https://private.test/${encodeURIComponent(ref)}`;
    },
    async deleteFile() {},
  };
  store = new MeetingAudioStore({
    rootDir: stagingRoot,
    storage: memoryStorage as ConstructorParameters<typeof MeetingAudioStore>[0]['storage'],
  });
});

afterAll(async () => {
  await rm(stagingRoot, { recursive: true, force: true });
});

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
      async sendPcm(pcm) {
        stream.frameSent(Buffer.from(pcm));
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
  const service = new MeetingRecordingService({ asr: { backend: 'tencent', open }, audioStore: store });
  service.onConnect(socket, user);
  return { streams, socket, service };
}

describe('ASR 上游切换后仍使用同一会议会话', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    models.update.mockResolvedValue([1]);
    models.create.mockResolvedValue({});
    // 上传前读取既有 audioStorageRef（幂等：无则 null）。
    models.findOne.mockResolvedValue({ audioStorageRef: null });
  });

  it('放弃暂停草稿后清除恢复资格，标记清理，不执行音频收尾', async () => {
    const { service, socket } = fixture();
    const started = await service.start(socket, user);
    if (!started.ok) throw new Error('start failed');
    const { sessionId } = started;
    await service.onAudio(socket, user, sessionId, 0, Buffer.alloc(6400));
    await service.pause(socket, user, sessionId);

    await expect(service.discard({ ...user, sid: 'other-login' }, sessionId)).resolves.toBe(false);
    const discarding = service.discard(user, sessionId);
    await expect(service.end(socket, user, sessionId, 0)).resolves.toMatchObject({ ok: false });
    await expect(discarding).resolves.toBe(true);
    expect(models.update).toHaveBeenCalledWith(
      { status: 'failed', audioStatus: 'deleting', audioPausedAttachDeadline: null },
      expect.objectContaining({ where: expect.objectContaining({ sessionId, userId: user.userId }) }),
    );
    await expect(service.attach(socket, user, sessionId)).resolves.toMatchObject({ ok: false });
    models.findOne.mockResolvedValueOnce(null);
    await expect(service.end(socket, user, sessionId, 0)).resolves.toMatchObject({ ok: false });
    models.update.mockResolvedValueOnce([0]);
    models.findOne.mockResolvedValueOnce({ audioStatus: 'deleting' });
    await expect(service.discard(user, sessionId)).resolves.toBe(true);
    await expect(service.start(socket, user)).resolves.toMatchObject({ ok: true });
    await service.close();
  });

  it('放弃落库失败后，仍能恢复暂停会话并再次放弃', async () => {
    const { service, socket } = fixture();
    const started = await service.start(socket, user);
    if (!started.ok) throw new Error('start failed');
    const { sessionId } = started;
    await service.pause(socket, user, sessionId);
    models.update.mockRejectedValueOnce(new Error('database offline'));
    await expect(service.discard(user, sessionId)).rejects.toThrow('database offline');
    await expect(service.attach(socket, user, sessionId)).resolves.toMatchObject({ ok: true, status: 'paused' });
    await expect(service.discard(user, sessionId)).resolves.toBe(true);
    await service.close();
  });

  it('结束后重放所有已保存的音频，并用重转写结果生成纪要', async () => {
    const { service, socket, streams } = fixture();
    const started = await service.start(socket, user);
    if (!started.ok) throw new Error('start failed');
    const { sessionId } = started;
    await service.onAudio(socket, user, sessionId, 0, Buffer.alloc(6400, 1));
    await service.pause(socket, user, sessionId);
    await vi.waitFor(() => expect(streams[0].close).toHaveBeenCalled());
    await service.resume(socket, user, sessionId);
    await service.onAudio(socket, user, sessionId, 1, Buffer.alloc(6400, 2));

    const record = { sessionId, audioStatus: 'ready', transcript: '', summaryError: 'final_transcript_pending', update: vi.fn() };
    record.update.mockImplementation(async patch => Object.assign(record, patch));
    models.findOne.mockResolvedValueOnce({ audioStorageRef: null }).mockResolvedValueOnce(record).mockResolvedValue(null);
    vi.mocked(generateMeetingSummary).mockResolvedValue({ title: '会议主题', summary: '最终纪要', keyPoints: [], mindmap: '{}' });
    service.startAudioTasks();
    try {
      await expect(service.end(socket, user, sessionId, 1)).resolves.toMatchObject({ ok: true });
      expect(models.update).toHaveBeenCalledWith(expect.objectContaining({ summaryStatus: 'generating', summaryError: 'final_transcript_pending' }), expect.anything());
      await vi.waitFor(() => expect(record.update).toHaveBeenCalledWith(expect.objectContaining({ summary: '最终纪要', summaryStatus: 'ready' })));
      expect(streams[2].frameSent).toHaveBeenCalledTimes(2);
      expect(record.transcript).toBe('第3句');
      expect(generateMeetingSummary).toHaveBeenCalledWith('第3句');
      expect(models.update).toHaveBeenCalledWith({ title: '会议主题' }, { where: { sessionId, title: '' } });
    } finally {
      await service.close();
    }
  });

  it('重启后继续用已落库的最终转写生成纪要', async () => {
    const { service, streams } = fixture();
    const record = { sessionId: 'saved-session', title: '手动命名', audioStatus: 'ready', transcript: '已完成重转写', summaryError: 'final_summary_pending', update: vi.fn() };
    record.update.mockImplementation(async patch => Object.assign(record, patch));
    models.findAll.mockResolvedValue([]);
    models.findOne.mockResolvedValueOnce(record).mockResolvedValue(null);
    vi.mocked(generateMeetingSummary).mockResolvedValue({ title: '自动标题', summary: '最终纪要', keyPoints: [], mindmap: '{}' });
    try {
      await service.markOrphanedSessions();
      await vi.waitFor(() => expect(record.update).toHaveBeenCalledWith(expect.objectContaining({ summaryStatus: 'ready' })));
      expect(generateMeetingSummary).toHaveBeenCalledWith('已完成重转写');
      expect(streams).toHaveLength(0);
      expect(models.update).not.toHaveBeenCalledWith({ title: '自动标题' }, expect.anything());
    } finally {
      await service.close();
    }
  });

  it('纪要可在成功或失败后再次生成，失败时保留原纪要', async () => {
    const { service } = fixture();
    const record = { sessionId: 'repeat-summary', audioStatus: 'ready', transcript: '会议转写', title: '会议标题',
      summaryStatus: 'ready', summaryError: null, summary: '旧纪要', update: vi.fn() };
    record.update.mockImplementation(async patch => Object.assign(record, patch));
    models.findOne.mockImplementation(async () => record.summaryStatus === 'generating' ? record : null);
    models.update.mockImplementation(async patch => {
      if (record.summaryStatus === 'generating') return [0];
      Object.assign(record, patch);
      return [1];
    });
    vi.mocked(generateMeetingSummary).mockRejectedValueOnce(new Error('network')).mockResolvedValue({ summary: '新纪要', keyPoints: [], mindmap: '{}' });
    service.startAudioTasks();
    try {
      await expect(service.queueSummaryRegeneration(record.sessionId, user.userId)).resolves.toBe(true);
      await vi.waitFor(() => expect(record).toMatchObject({ summaryStatus: 'failed', summary: '旧纪要' }));
      await expect(service.queueSummaryRegeneration(record.sessionId, user.userId)).resolves.toBe(true);
      await vi.waitFor(() => expect(record).toMatchObject({ summaryStatus: 'ready', summary: '新纪要' }));
      await expect(service.queueSummaryRegeneration(record.sessionId, user.userId)).resolves.toBe(true);
      await vi.waitFor(() => expect(generateMeetingSummary).toHaveBeenCalledTimes(3));
    } finally {
      await service.close();
    }
  });

  it('从七牛签名地址重放已归档录音，不依赖本地暂存及网络分块边界', async () => {
    const { service, streams } = fixture();
    const pcm = Buffer.alloc(6402, 7);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16_000, 24);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);
    const audio = Buffer.concat([header, pcm]);
    const response = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(audio.subarray(0, 13));
      controller.enqueue(audio.subarray(13, 3001));
      controller.enqueue(audio.subarray(3001));
      controller.close();
    } }));
    const download = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const record = { sessionId: 'archived-session', audioStatus: 'ready', audioStorageRef: 'qiniu://private/meetings/audio/a.wav',
      transcript: '', summaryError: 'final_transcript_pending', update: vi.fn() };
    record.update.mockImplementation(async patch => Object.assign(record, patch));
    models.findAll.mockResolvedValue([]);
    models.findOne.mockResolvedValueOnce(record).mockResolvedValue(null);
    vi.mocked(generateMeetingSummary).mockResolvedValue({ summary: '最终纪要', keyPoints: [], mindmap: '{}' });
    try {
      await service.markOrphanedSessions();
      await vi.waitFor(() => expect(record.update).toHaveBeenCalledWith(expect.objectContaining({ summaryStatus: 'ready' })));
      expect(download).toHaveBeenCalledWith(expect.stringContaining('https://private.test/'), expect.objectContaining({ redirect: 'error' }));
      expect(streams[0].frameSent.mock.calls).toEqual([[pcm.subarray(0, 6400)], [pcm.subarray(6400)]]);
    } finally {
      download.mockRestore();
      await service.close();
    }
  });

  it('重转写失败时保留实时文字，不用实时文字生成最终纪要', async () => {
    const { service } = fixture();
    const record = { sessionId: 'missing-audio-session', audioStatus: 'ready', transcript: '实时转写', summaryError: 'final_transcript_pending', update: vi.fn() };
    record.update.mockImplementation(async patch => Object.assign(record, patch));
    models.findAll.mockResolvedValue([]);
    models.findOne.mockResolvedValueOnce(record).mockResolvedValue(null);
    try {
      await service.markOrphanedSessions();
      await vi.waitFor(() => expect(record.update).toHaveBeenCalledWith({ summaryStatus: 'failed', summaryError: 'final_transcript_failed' }));
      expect(record.transcript).toBe('实时转写');
      expect(generateMeetingSummary).not.toHaveBeenCalled();
    } finally {
      await service.close();
    }
  });

  it('暂停收尾、继续时重新连接，新流从序号 0 开始也能保存两句', async () => {
    const { service, socket, streams } = fixture();
    const started = await service.start(socket, user);
    if (!started.ok) throw new Error('start failed');
    const { sessionId } = started;
    expect(await service.onAudio(socket, user, sessionId, 0, Buffer.alloc(6400))).toMatchObject({ acceptedSamples: 3200 });
    await service.pause(socket, user, sessionId);
    await vi.waitFor(() => expect(streams[0].close).toHaveBeenCalledOnce());
    expect(streams).toHaveLength(1);
    await service.resume(socket, user, sessionId);
    expect(await service.onAudio(socket, user, sessionId, 1, Buffer.alloc(6400))).toMatchObject({ acceptedSamples: 6400 });
    expect(await service.end(socket, user, sessionId, 1)).toMatchObject({ ok: true, transcriptComplete: true });
    const persisted = models.update.mock.lastCall?.[0];
    expect(persisted.transcript).toBe('第1句\n第2句');
    expect(JSON.parse(persisted.transcriptJson)).toMatchObject([
      { segmentId: 0, startMs: 0, endMs: 200 },
      { segmentId: 1, startMs: 200, endMs: 400 },
    ]);
    // 音频保存与转写保存走同一收尾：正常结束标记 ready。
    expect(persisted.audioStatus).toBe('ready');
  });

  it('意外断流后可以继续，但保存时仍明确标记转写不完整', async () => {
    const { service, socket, streams } = fixture();
    const started = await service.start(socket, user);
    if (!started.ok) throw new Error('start failed');
    const { sessionId } = started;
    await service.onAudio(socket, user, sessionId, 0, Buffer.alloc(6400));
    await vi.waitFor(() => expect(streams[0].frameSent).toHaveBeenCalledOnce());
    streams[0].listener.onFault(new Error('ASR_CLOSED'));
    await service.onAudio(socket, user, sessionId, 1, Buffer.alloc(6400));
    expect(await service.end(socket, user, sessionId, 1)).toMatchObject({ ok: true, transcriptComplete: false });
    const persisted = models.update.mock.lastCall?.[0];
    expect(persisted).toMatchObject({ status: 'failed', transcript: '第2句' });
    // ASR 故障不阻止音频保存：音频状态仍为 ready。
    expect(persisted.audioStatus).toBe('ready');
  });

  it('ACK 对应持久化进度：manifest 落盘后才返回确认，重复分片不重复累计', async () => {
    const { service, socket } = fixture();
    const started = await service.start(socket, user);
    if (!started.ok) throw new Error('start failed');
    const { sessionId } = started;
    const first = await service.onAudio(socket, user, sessionId, 0, Buffer.alloc(6400));
    expect(first).toMatchObject({ lastAcceptedAudioIndex: 0, acceptedSamples: 3200 });
    // manifest 已持久化，进度一致。
    const manifest = await store.loadManifest(sessionId);
    expect(manifest.ok).toBe(true);
    if (manifest.ok) expect(manifest.manifest).toMatchObject({ lastAcceptedAudioIndex: 0, acceptedSamples: 3200 });
    // 重复分片：返回已有确认，不重复累计。
    const dup = await service.onAudio(socket, user, sessionId, 0, Buffer.alloc(6400));
    expect(dup).toMatchObject({ lastAcceptedAudioIndex: 0, acceptedSamples: 3200 });
    const manifestAfter = await store.loadManifest(sessionId);
    expect(manifestAfter.ok).toBe(true);
    if (manifestAfter.ok) expect(manifestAfter.manifest).toMatchObject({ lastAcceptedAudioIndex: 0, acceptedSamples: 3200 });
  });
});

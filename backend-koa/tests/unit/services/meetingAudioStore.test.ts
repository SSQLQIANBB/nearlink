import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MeetingAudioStore } from '../../../src/services/meetingAudioStore';

let stagingRoot: string;
let uploads: Array<{ key: string; file: string; scope: string }>;
let store: MeetingAudioStore;

function makeStore() {
  uploads = [];
  const memoryStorage: NonNullable<ConstructorParameters<typeof MeetingAudioStore>[0]['storage']> = {
    async uploadFile(file, key, scope) {
      uploads.push({ key, file, scope });
      return { key, scope, storageRef: `qiniu://${scope}/${key}`, fileUrl: `https://private.test/${encodeURIComponent(key)}` };
    },
    resolveUrl(ref: string) {
      return `https://private.test/${encodeURIComponent(ref)}`;
    },
    async deleteFile() {},
  };
  return new MeetingAudioStore({
    rootDir: stagingRoot,
    storage: memoryStorage,
  });
}

beforeAll(async () => {
  stagingRoot = await mkdtemp(path.join(tmpdir(), 'meeting-audio-store-test-'));
});

afterAll(async () => {
  await rm(stagingRoot, { recursive: true, force: true });
});

beforeEach(() => {
  store = makeStore();
});

describe('MeetingAudioStore 暂存与持久化', () => {
  it('appendChunk 持久化进度：manifest 与分片文件一致，序号连续性校验', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000';
    await store.createSession(sessionId);
    const m1 = await store.appendChunk(sessionId, 0, Buffer.alloc(6400, 1));
    expect(m1).toMatchObject({ lastAcceptedAudioIndex: 0, acceptedSamples: 3200 });
    const m2 = await store.appendChunk(sessionId, 1, Buffer.alloc(6400, 2));
    expect(m2).toMatchObject({ lastAcceptedAudioIndex: 1, acceptedSamples: 6400 });
    const loaded = await store.loadManifest(sessionId);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.manifest).toMatchObject({ lastAcceptedAudioIndex: 1, acceptedSamples: 6400 });
    expect(loaded.ok && loaded.manifest.audioKey).toMatch(/^meetings\/audio\/\d{4}\/\d{2}\/[0-9a-f-]+\.wav$/);
    const chunkStat = await stat(store.chunkPath(sessionId, 1));
    expect(chunkStat.size).toBe(6400);
    // 重复序号：返回已有进度，不重复累计。
    const dup = await store.appendChunk(sessionId, 1, Buffer.alloc(6400));
    expect(dup).toMatchObject({ lastAcceptedAudioIndex: 1, acceptedSamples: 6400 });
    // 序号跳跃：抛错，不静默跳过。
    await expect(store.appendChunk(sessionId, 5, Buffer.alloc(6400))).rejects.toThrow(/跳跃/);
  });

  it('manifest 缺失时按连续序号重建进度，audioKey 固定不重新生成', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0001';
    await store.createSession(sessionId);
    const created = await store.loadManifest(sessionId);
    const originalKey = created.ok ? created.manifest.audioKey : '';
    await store.appendChunk(sessionId, 0, Buffer.alloc(6400));
    await store.appendChunk(sessionId, 1, Buffer.alloc(6400));
    // manifest 可读时 recoverManifest 复用 audioKey 并校正进度。
    const recovered = await store.recoverManifest(sessionId);
    expect(recovered.audioKey).toBe(originalKey);
    expect(recovered).toMatchObject({ lastAcceptedAudioIndex: 1, acceptedSamples: 6400 });
    // 新分片只累计一次（在已恢复累计值之上 +1 片）。
    const next = await store.appendChunk(sessionId, 2, Buffer.alloc(6400));
    expect(next).toMatchObject({ lastAcceptedAudioIndex: 2, acceptedSamples: 9600 });
  });

  it('manifest 损坏时区分 corrupt，不吞成无音频', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0002';
    await store.createSession(sessionId);
    await store.appendChunk(sessionId, 0, Buffer.alloc(6400));
    // 直接写入非法 JSON 制造损坏。
    const { writeFile } = await import('node:fs/promises');
    await writeFile(store.manifestPath(sessionId), '{not-json', 'utf8');
    const loaded = await store.loadManifest(sessionId);
    expect(loaded.ok).toBe(false);
    if (loaded.ok === false) expect(loaded.reason).toBe('corrupt');
  });

  it('encodeWav 按连续范围封装：WAV 头正确，缺口停止并标不完整', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0003';
    await store.createSession(sessionId);
    await store.appendChunk(sessionId, 0, Buffer.alloc(6400, 1));
    await store.appendChunk(sessionId, 1, Buffer.alloc(6400, 2));
    const full = await store.encodeWav(sessionId, 16000, 1);
    expect(full).toMatchObject({ samples: 6400, dataBytes: 12800, complete: true, gapIndex: null });
    const buf = await readFile(full.filePath!);
    expect(buf.length).toBe(44 + 12800);
    expect(buf.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(buf.readUInt32LE(4)).toBe(36 + 12800);
    expect(buf.readUInt32LE(40)).toBe(12800);
    expect(buf.readUInt32LE(24)).toBe(16000);
    expect(buf.subarray(44, 44 + 6400).equals(Buffer.alloc(6400, 1))).toBe(true);
    expect(buf.subarray(44 + 6400, 44 + 12800).equals(Buffer.alloc(6400, 2))).toBe(true);

    // 缺口：只有片 0，请求封装到序号 1 → 在序号 1 处停止，标不完整。
    const sessionId2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0004';
    await store.createSession(sessionId2);
    await store.appendChunk(sessionId2, 0, Buffer.alloc(6400));
    const gap = await store.encodeWav(sessionId2, 16000, 1);
    expect(gap.complete).toBe(false);
    expect(gap.gapIndex).toBe(1);
    expect(gap.samples).toBe(3200);
  });

  it('encodeWav 无分片时不产出文件（调用方标 missing）', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0005';
    await store.createSession(sessionId);
    const none = await store.encodeWav(sessionId, 16000, 0);
    expect(none.filePath).toBeNull();
    expect(none.samples).toBe(0);
  });

  it('uploadToQiniu 幂等：已有 storageRef 不重复上传，固定对象 key，长度校验', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0006';
    await store.createSession(sessionId);
    await store.appendChunk(sessionId, 0, Buffer.alloc(6400));
    const encoded = await store.encodeWav(sessionId, 16000, 0);
    expect(encoded.filePath).not.toBeNull();
    const loaded = await store.loadManifest(sessionId);
    const key = loaded.ok ? loaded.manifest.audioKey : '';
    const first = await store.uploadToQiniu(sessionId, null);
    expect(first.key).toBe(key);
    expect(uploads).toHaveLength(1);
    // 模拟"上传成功但数据库更新失败"后的重试：传入已有 ref，不重复上传。
    const second = await store.uploadToQiniu(sessionId, first.storageRef);
    expect(second).toEqual(first);
    expect(uploads).toHaveLength(1);
  });
});

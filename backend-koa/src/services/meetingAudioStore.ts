import { createReadStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../config/env';
import { qiniuStorage, createStorageReference } from './qiniuStorageService';

/**
 * 会议录音音频暂存与持久化。
 *
 * 职责边界（协议见 docs/MEETING_RECORDING_PROTOCOL.md）：
 * - 音频分片先写入暂存目录并 fsync，manifest（分片序号/累计样本数/七牛对象 key）
 *   落盘后才允许发出 ACK；ACK 即"截至该序号的连续音频已可靠持久化"的确认；
 * - 保障级别：进程崩溃恢复（不承诺主机掉电；掉电可能丢最后 1-2 片，按 partial 处理）；
 * - 暂存目录只用于录制暂存、异常恢复和上传重试，最终音频统一上传七牛私有空间；
 * - WAV 封装流式读取分片文件（背压），不把整场音频读入内存；
 * - 七牛上传固定使用会话创建时预分配的对象 key：同一场会议无论重试多少次
 *   都写同一个对象，不会因重试反复创建对象。
 *
 * 目录结构（每场会议一个目录）：
 *   <root>/<sessionId>/manifest.json     进度与对象 key（tmp→rename→fsync 目录）
 *   <root>/<sessionId>/pcm-NNNNNN.pcm    已确认分片（tmp→rename 原子落地 + fsync）
 *   <root>/<sessionId>/audio.wav         收尾封装产物（tmp→rename，仅未 ready 时保留供重试）
 *   <root>/<sessionId>/orphan/           未被确认的尾部孤立分片（隔离，不拼接不删除）
 */

export type MeetingAudioStatus =
  | 'recording'
  | 'pending'
  | 'uploading'
  | 'ready'
  | 'partial'
  | 'failed'
  | 'missing'
  | 'deleting';

export interface MeetingAudioManifest {
  sessionId: string;
  lastAcceptedAudioIndex: number;
  acceptedSamples: number;
  /** 七牛私有空间对象 key；会话创建时确定，恢复与重试不更换。 */
  audioKey: string;
  /** 手动暂停（含断线/暂停中重启）的恢复截止时间；null 表示无限制（recording）。 */
  pausedAttachDeadline: number | null;
  userId?: number;
  sid?: string;
  source?: 'offline' | 'call';
  callId?: string;
  clientComplete?: boolean;
  uploadedRef?: string;
  createdAt: number;
  updatedAt: number;
}

/** manifest 读取结果：区分不存在、格式损坏与 IO 错误，不统一吞成"无音频"。 */
export type ManifestLoadResult =
  | { ok: true; manifest: MeetingAudioManifest }
  | { ok: false; reason: 'not_found' | 'corrupt' | 'io'; message: string };

type StorageUpload = Pick<typeof qiniuStorage, 'uploadFile' | 'resolveUrl' | 'deleteFile'>;

const CHUNK_RE = /^pcm-(\d{6})\.pcm$/;

/** 写文件并用同一可写句柄 fsync，Windows 无法同步只读文件句柄。 */
async function writeFileSynced(filePath: string, data: Buffer): Promise<void> {
  const fd = await fsp.open(filePath, 'w');
  try {
    await fd.writeFile(data);
    await fd.sync();
  } finally {
    await fd.close();
  }
}

/** 持久化 JSON：tmp 写入 + fsync → rename 原子替换 → fsync 目录。 */
async function writeJsonFileAtomic(filePath: string, data: unknown): Promise<void> {
  const tmp = `${filePath}.tmp`;
  await writeFileSynced(tmp, Buffer.from(JSON.stringify(data), 'utf8'));
  await fsp.rename(tmp, filePath);
  await fsyncDir(path.dirname(filePath));
}

async function fsyncDir(dir: string): Promise<void> {
  try {
    const fd = await fsp.open(dir, 'r');
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EINVAL' || code === 'ENOTSUP' || (process.platform === 'win32' && (code === 'EPERM' || code === 'EISDIR'))) return;
    throw error;
  }
}

export interface EncodeWavResult {
  filePath: string | null;
  dataBytes: number;
  samples: number;
  complete: boolean;
  gapIndex: number | null;
}

export class MeetingAudioStore {
  private readonly root: string;
  private readonly storage: StorageUpload;

  constructor(options: { rootDir?: string; storage?: StorageUpload } = {}) {
    this.root = options.rootDir || env.meetings.audioStagingDir;
    this.storage = options.storage ?? qiniuStorage;
  }

  get rootDir(): string {
    return this.root;
  }

  sessionDir(sessionId: string): string {
    return path.join(this.root, sessionId);
  }

  manifestPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), 'manifest.json');
  }

  chunkPath(sessionId: string, index: number): string {
    return path.join(this.sessionDir(sessionId), `pcm-${String(index).padStart(6, '0')}.pcm`);
  }

  wavPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), 'audio.wav');
  }

  /** 创建暂存目录并写入初始 manifest；audioKey 在会话创建时确定，后续不更换。 */
  async createSession(sessionId: string, identity: Pick<MeetingAudioManifest, 'userId' | 'sid' | 'source' | 'callId'> = {}): Promise<void> {
    const dir = this.sessionDir(sessionId);
    await fsp.mkdir(dir, { recursive: true });
    const now = Date.now();
    const manifest: MeetingAudioManifest = {
      sessionId,
      ...identity,
      lastAcceptedAudioIndex: -1,
      acceptedSamples: 0,
      audioKey: `meetings/audio/${this.dateDir()}/${uuidv4()}.wav`,
      pausedAttachDeadline: null,
      createdAt: now,
      updatedAt: now,
    };
    await writeJsonFileAtomic(path.join(dir, 'identity.json'), {
      sessionId, audioKey: manifest.audioKey, createdAt: now, ...identity,
    });
    await writeJsonFileAtomic(this.manifestPath(sessionId), manifest);
  }

  private dateDir(): string {
    const now = new Date();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    return `${String(now.getUTCFullYear())}/${month}`;
  }

  /** 读取 manifest；区分 not_found / corrupt / io，不统一吞成"无音频"。 */
  async loadManifest(sessionId: string): Promise<ManifestLoadResult> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.manifestPath(sessionId), 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') return { ok: false, reason: 'not_found', message: 'manifest 不存在' };
      return { ok: false, reason: 'io', message: (error as Error)?.message ?? 'io' };
    }
    let value: MeetingAudioManifest;
    try {
      value = JSON.parse(raw) as MeetingAudioManifest;
    } catch {
      return { ok: false, reason: 'corrupt', message: 'manifest 格式损坏' };
    }
    if (
      typeof value?.lastAcceptedAudioIndex !== 'number' ||
      typeof value?.acceptedSamples !== 'number' ||
      typeof value?.audioKey !== 'string' ||
      !value.audioKey || value.sessionId !== sessionId ||
      !Number.isSafeInteger(value.lastAcceptedAudioIndex) || value.lastAcceptedAudioIndex < -1 ||
      !Number.isSafeInteger(value.acceptedSamples) || value.acceptedSamples < 0
    ) {
      return { ok: false, reason: 'corrupt', message: 'manifest 字段缺失' };
    }
    return { ok: true, manifest: value };
  }

  /**
   * 追加一个分片：序号连续性校验 → 分片文件落盘（tmp→rename+fsync）→ manifest 进度落盘。
   * 返回最新 manifest；重复/跳跃由调用方在会话层去重，store 层做最终兜底。
   */
  async appendChunk(sessionId: string, index: number, pcm: Buffer): Promise<MeetingAudioManifest> {
    const dir = this.sessionDir(sessionId);
    await fsp.mkdir(dir, { recursive: true });
    const loaded = await this.loadManifest(sessionId);
    const manifest = loaded.ok
      ? loaded.manifest
      : await this.recoverManifest(sessionId);

    if (index !== manifest.lastAcceptedAudioIndex + 1) {
      // 会话层已去重；store 层兜底：重复返回已有进度，跳跃抛错（不静默跳过）。
      if (index <= manifest.lastAcceptedAudioIndex) return manifest;
      throw new Error(`分片序号跳跃：期望 ${manifest.lastAcceptedAudioIndex + 1}，收到 ${index}`);
    }
    const chunkFile = this.chunkPath(sessionId, index);
    const chunkTmp = `${chunkFile}.tmp`;
    await writeFileSynced(chunkTmp, pcm);
    await fsp.rename(chunkTmp, chunkFile);
    await fsyncDir(dir);

    manifest.lastAcceptedAudioIndex = index;
    manifest.acceptedSamples += pcm.length / 2;
    manifest.updatedAt = Date.now();
    await writeJsonFileAtomic(this.manifestPath(sessionId), manifest);
    return manifest;
  }

  /**
   * manifest 缺失/损坏时的恢复：按连续序号从 0 重建确认点，校验每片存在与偶数字节；
   * 缺口处停止，缺口后的孤立分片隔离到 orphan/；audioKey 从独立身份文件读回，
   * 无法证明原对象身份时保留文件并报错，绝不生成新 key。
   */
  async recoverManifest(sessionId: string): Promise<MeetingAudioManifest> {
    const dir = this.sessionDir(sessionId);
    const loaded = await this.loadManifest(sessionId);
    if (loaded.ok === false && loaded.reason === 'io') throw new Error('manifest_io');
    const identity = loaded.ok ? loaded.manifest : JSON.parse(await fsp.readFile(path.join(dir, 'identity.json'), 'utf8')) as MeetingAudioManifest;
    if (identity.sessionId !== sessionId || !identity.audioKey) throw new Error('identity_corrupt');
    const progress = await this.scanContiguous(dir);
    if (loaded.ok && progress.lastIndex < loaded.manifest.lastAcceptedAudioIndex) {
      throw new Error('confirmed_audio_missing');
    }
    const manifest: MeetingAudioManifest = {
      ...(loaded.ok ? loaded.manifest : identity),
      sessionId,
      audioKey: identity.audioKey,
      lastAcceptedAudioIndex: progress.lastIndex,
      acceptedSamples: progress.samples,
      pausedAttachDeadline: loaded.ok ? loaded.manifest.pausedAttachDeadline : Date.now(),
      createdAt: identity.createdAt,
      updatedAt: Date.now(),
    };
    await this.isolateOrphans(dir, progress.lastIndex);
    await writeJsonFileAtomic(this.manifestPath(sessionId), manifest);
    return manifest;
  }

  async updateManifest(sessionId: string, patch: Partial<Pick<MeetingAudioManifest,
    'pausedAttachDeadline' | 'clientComplete' | 'uploadedRef'>>): Promise<MeetingAudioManifest> {
    const loaded = await this.loadManifest(sessionId);
    if (loaded.ok === false) throw new Error('manifest_' + loaded.reason);
    Object.assign(loaded.manifest, patch, { updatedAt: Date.now() });
    await writeJsonFileAtomic(this.manifestPath(sessionId), loaded.manifest);
    return loaded.manifest;
  }

  /** 扫描会话目录，返回从 0 起连续分片的确认点（lastIndex）与样本数；遇缺口停止。 */
  private async scanContiguous(dir: string): Promise<{ lastIndex: number; samples: number; gapIndex: number | null }> {
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      return { lastIndex: -1, samples: 0, gapIndex: null };
    }
    const sizes = new Map<number, number>();
    for (const name of entries) {
      const m = CHUNK_RE.exec(name);
      if (!m) continue;
      try {
        const stat = await fsp.stat(path.join(dir, name));
        sizes.set(Number(m[1]), stat.size);
      } catch {
        // 单片 stat 失败视为缺失，由连续性检查暴露为缺口。
      }
    }
    let samples = 0;
    let lastIndex = -1;
    for (let index = 0; index < 1_000_000; index++) {
      const size = sizes.get(index);
      if (size === undefined) {
        return { lastIndex, samples, gapIndex: index };
      }
      if (size === 0 || size % 2 !== 0) {
        // 奇数字节分片损坏：视为缺口，停止连续确认。
        return { lastIndex, samples, gapIndex: index };
      }
      samples += size / 2;
      lastIndex = index;
    }
    return { lastIndex, samples, gapIndex: null };
  }

  /** 把确认点之后的孤立分片移入 orphan/ 隔离（不删除、不拼接）。 */
  private async isolateOrphans(dir: string, confirmedLastIndex: number): Promise<void> {
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      return;
    }
    const orphanDir = path.join(dir, 'orphan');
    for (const name of entries) {
      const m = CHUNK_RE.exec(name);
      if (!m) continue;
      const index = Number(m[1]);
      if (index <= confirmedLastIndex) continue;
      await fsp.mkdir(orphanDir, { recursive: true });
      try {
        await fsp.rename(path.join(dir, name), path.join(orphanDir, name));
      } catch {
        // 隔离失败不致命：该分片下次扫描仍会作为缺口暴露。
      }
    }
  }

  /** 更新暂停截止时间（与音频追加在同一会话串行链内调用，避免整份覆盖丢更新）。 */
  async updatePausedAttachDeadline(sessionId: string, deadline: number | null): Promise<void> {
    await this.updateManifest(sessionId, { pausedAttachDeadline: deadline });
  }

  /**
   * 流式 WAV 封装：只封装 [0, lastConfirmedIndex] 内连续分片；遇缺口/损坏即停止并标不完整。
   * 先扫描边界，再写 WAV 头与连续 PCM → fsync → close → 原子 rename。
   * 无分片时不产出文件（调用方标 missing）。
   */
  async encodeWav(sessionId: string, sampleRate: number, lastConfirmedIndex: number): Promise<EncodeWavResult> {
    const dir = this.sessionDir(sessionId);
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      return { filePath: null, dataBytes: 0, samples: 0, complete: false, gapIndex: 0 };
    }
    const sizes = new Map<number, number>();
    for (const name of entries) {
      const m = CHUNK_RE.exec(name);
      if (!m) continue;
      try {
        const stat = await fsp.stat(path.join(dir, name));
        sizes.set(Number(m[1]), stat.size);
      } catch {
        // 缺失分片由连续性检查暴露。
      }
    }
    // 预扫描连续范围，确定数据字节数（用于校验），并收集有序文件列表。
    const files: string[] = [];
    let samples = 0;
    let gapIndex: number | null = null;
    for (let index = 0; index <= lastConfirmedIndex; index++) {
      const size = sizes.get(index);
      if (size === undefined || size === 0 || size % 2 !== 0) {
        gapIndex = index;
        break;
      }
      samples += size / 2;
      files.push(this.chunkPath(sessionId, index));
    }
    const dataBytes = samples * 2;
    if (files.length === 0) {
      return { filePath: null, dataBytes: 0, samples: 0, complete: gapIndex === null, gapIndex };
    }

    const wavFinal = this.wavPath(sessionId);
    const wavTmp = `${wavFinal}.tmp`;

    const header = Buffer.alloc(44);
    const writeHeader = (totalDataBytes: number) => {
      header.write('RIFF', 0);
      header.writeUInt32LE(36 + totalDataBytes, 4);
      header.write('WAVE', 8);
      header.write('fmt ', 12);
      header.writeUInt32LE(16, 16);
      header.writeUInt16LE(1, 20); // PCM
      header.writeUInt16LE(1, 22); // mono
      header.writeUInt32LE(sampleRate, 24);
      header.writeUInt32LE(sampleRate * 2, 28);
      header.writeUInt16LE(2, 32);
      header.writeUInt16LE(16, 34);
      header.write('data', 36);
      header.writeUInt32LE(totalDataBytes, 40);
    };

    const fd = await fsp.open(wavTmp, 'w');
    try {
      writeHeader(dataBytes);
      await fd.writeFile(header);
      for (const file of files) {
        for await (const bytes of createReadStream(file)) await fd.writeFile(bytes as Buffer);
      }
      await fd.sync();
    } finally { await fd.close(); }
    // 校验最终文件长度与预期一致，避免产出长度不符的 WAV。
    const finalStat = await fsp.stat(wavTmp);
    if (finalStat.size !== 44 + dataBytes) {
      await fsp.rm(wavTmp, { force: true }).catch(() => undefined);
      throw new Error(`WAV 长度不符：期望 ${44 + dataBytes}，实际 ${finalStat.size}`);
    }
    await fsp.rename(wavTmp, wavFinal);
    await fsyncDir(dir);
    return { filePath: wavFinal, dataBytes, samples, complete: gapIndex === null, gapIndex };
  }

  /**
   * 上传 WAV 到七牛私有空间（幂等）：
   * - 复用会话创建时的固定 key，重试不产生新对象；
   * - 已有 audioStorageRef 时不重复上传（处理"上传成功但数据库更新失败"的重试）；
   * - 上传前校验 WAV 长度与 manifest 一致，避免上传半成品。
   */
  async uploadToQiniu(sessionId: string, existingStorageRef: string | null): Promise<{ storageRef: string; key: string }> {
    const loaded = await this.loadManifest(sessionId);
    if (loaded.ok === false) throw new Error(loaded.reason === 'not_found' ? '音频暂存不存在' : `manifest 不可用：${loaded.message}`);
    const manifest = loaded.manifest;
    const savedRef = existingStorageRef ?? manifest.uploadedRef;
    if (savedRef) return { storageRef: savedRef, key: manifest.audioKey };
    const wav = this.wavPath(sessionId);
    const stat = await fsp.stat(wav).catch(() => null);
    if (!stat) throw new Error('WAV 文件不存在，无法上传');
    const fd = await fsp.open(wav, 'r');
    try {
      const header = Buffer.alloc(44);
      await fd.read(header, 0, 44, 0);
      if (header.toString('ascii', 0, 4) !== 'RIFF' || header.readUInt32LE(40) + 44 !== stat.size) {
        throw new Error('wav_corrupt');
      }
    } finally { await fd.close(); }
    const uploaded = await this.storage.uploadFile(wav, manifest.audioKey, 'private', 'audio/wav', stat.size);
    const storageRef = uploaded.storageRef;
    await this.updateManifest(sessionId, { uploadedRef: storageRef });
    return { storageRef, key: manifest.audioKey };
  }


  /** 生成播放地址（私有空间走签名 URL）。 */
  resolveUrl(storageRef: string): string {
    return this.storage.resolveUrl(storageRef);
  }

  /** 删除七牛对象与本地暂存目录；两者独立，部分失败抛出合并错误不掩盖。 */
  async deleteRecorded(sessionId: string, storageRef: string | null): Promise<{ qiniu: boolean; local: boolean; errors: string[] }> {
    const errors: string[] = [];
    let qiniu = true;
    let local = true;
    const loaded = await this.loadManifest(sessionId);
    let reference = storageRef ?? (loaded.ok ? loaded.manifest.uploadedRef ?? createStorageReference('private', loaded.manifest.audioKey) : null);
    if (!reference && loaded.ok === false) {
      try {
        const identity = JSON.parse(await fsp.readFile(path.join(this.sessionDir(sessionId), 'identity.json'), 'utf8'));
        if (identity.sessionId !== sessionId || typeof identity.audioKey !== 'string') throw new Error('identity_corrupt');
        reference = createStorageReference('private', identity.audioKey);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { qiniu: false, local: false, errors: ['identity_unavailable'] };
      }
    }
    if (reference) {
      try {
        await this.storage.deleteFile(reference);
      } catch (error) {
        qiniu = false;
        errors.push(`七牛删除失败：${(error as Error)?.message}`);
      }
    }
    try {
      if (!qiniu) return { qiniu, local: false, errors };
      await fsp.rm(this.sessionDir(sessionId), { recursive: true, force: true });
    } catch (error) {
      local = false;
      errors.push(`本地暂存删除失败：${(error as Error)?.message}`);
    }
    return { qiniu, local, errors };
  }

  /** 成功保存后清理本地暂存（七牛对象已持久化）。 */
  async removeLocal(sessionId: string): Promise<void> {
    await fsp.rm(this.sessionDir(sessionId), { recursive: true, force: true });
  }
}

export const meetingAudioStore = new MeetingAudioStore();

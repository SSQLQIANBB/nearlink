import { describe, expect, it, vi } from 'vitest';
import {
  buildObjectKey,
  createStorageReference,
  parseStorageReference,
  QiniuStorageService,
} from '../../../src/services/qiniuStorageService';
import { qiniuStorageConfig } from '../../../src/config/qiniu';

const config = {
  accessKey: 'access-key',
  secretKey: 'secret-key',
  publicBucket: 'public-bucket',
  privateBucket: 'private-bucket',
  publicDomain: 'https://files.example.test',
  privateDomain: 'https://private-files.example.test',
  signedUrlExpires: 3600,
};

function createDependencies() {
  return {
    uploader: {
      putFile: vi.fn().mockResolvedValue({ ok: () => true, data: {} }),
    },
    bucketManager: {
      delete: vi.fn().mockResolvedValue({ ok: () => true, data: {} }),
      publicDownloadUrl: vi.fn((domain: string, key: string) => `${domain}/${key}`),
      privateDownloadUrl: vi.fn(
        (domain: string, key: string, deadline: number) => `${domain}/${key}?e=${deadline}`,
      ),
    },
    createUploadToken: vi.fn((bucket: string, key: string) => `${bucket}:${key}:token`),
  };
}

describe('七牛对象存储', () => {
  it('使用项目固定的公共空间、私有空间和签名有效期', () => {
    expect(qiniuStorageConfig).toEqual({
      publicBucket: 'to-desk-pub',
      privateBucket: 'to-desk',
      signedUrlExpires: 3600,
    });
  });

  it('生成稳定存储引用和分层对象 key', () => {
    expect(createStorageReference('private', 'chat/2026/09/file.png')).toBe(
      'qiniu://private/chat/2026/09/file.png',
    );
    expect(parseStorageReference('qiniu://public/avatar/a.png')).toEqual({
      scope: 'public',
      key: 'avatar/a.png',
    });
    expect(parseStorageReference('https://files.example.test/a.png')).toBeNull();
    expect(buildObjectKey('avatar', 'ME.PNG', new Date('2026-09-18T00:00:00Z'), 'id')).toBe(
      'avatar/2026/09/id.png',
    );
  });

  it('上传到指定空间并只把稳定引用交给数据库', async () => {
    const dependencies = createDependencies();
    const storage = new QiniuStorageService(config, dependencies);

    const result = await storage.uploadFile(
      '/tmp/photo.png',
      'chat/2026/09/photo.png',
      'private',
      'image/png',
      1024,
    );

    expect(dependencies.createUploadToken).toHaveBeenCalledWith(
      'private-bucket',
      'chat/2026/09/photo.png',
      1024,
    );
    expect(dependencies.uploader.putFile).toHaveBeenCalledWith(
      'private-bucket:chat/2026/09/photo.png:token',
      'chat/2026/09/photo.png',
      '/tmp/photo.png',
      expect.anything(),
    );
    expect(result).toMatchObject({
      storageRef: 'qiniu://private/chat/2026/09/photo.png',
      fileUrl: expect.stringContaining(
        'https://private-files.example.test/chat/2026/09/photo.png?e=',
      ),
    });
  });

  it('公开文件直接使用 CDN 地址，私有文件按读取时刻签名', () => {
    const dependencies = createDependencies();
    const storage = new QiniuStorageService(config, dependencies);

    expect(storage.resolveUrl('qiniu://public/avatar/me.png')).toBe(
      'https://files.example.test/avatar/me.png',
    );
    expect(storage.resolveUrl('/uploads/legacy.png')).toBe('/uploads/legacy.png');
    expect(storage.resolveUrl('qiniu://private/chat/voice.webm')).toContain(
      'https://private-files.example.test/chat/voice.webm?e=',
    );
    expect(dependencies.bucketManager.privateDownloadUrl).toHaveBeenCalledOnce();
  });

  it('按存储引用删除对应空间中的对象', async () => {
    const dependencies = createDependencies();
    const storage = new QiniuStorageService(config, dependencies);

    await storage.deleteFile('qiniu://private/file/a.zip');
    expect(dependencies.bucketManager.delete).toHaveBeenCalledWith('private-bucket', 'file/a.zip');
    await expect(storage.deleteFile('/uploads/a.zip')).rejects.toThrow('七牛云文件引用无效');
  });
});

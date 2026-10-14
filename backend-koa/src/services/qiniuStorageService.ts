import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import * as qiniu from 'qiniu';
import { env } from '../config/env';
import { qiniuStorageConfig } from '../config/qiniu';

export type QiniuStorageScope = 'public' | 'private';
export type UploadPurpose = 'avatar' | 'chat' | 'file';

type QiniuStorageConfig = {
  accessKey: string;
  secretKey: string;
  publicBucket: string;
  privateBucket: string;
  publicDomain: string;
  privateDomain: string;
  signedUrlExpires: number;
};

type QiniuResponse = {
  data?: { error?: string };
  ok(): boolean;
};

type QiniuUploader = {
  putFile(
    uploadToken: string,
    key: string,
    localFile: string,
    putExtra: qiniu.form_up.PutExtra,
  ): Promise<QiniuResponse>;
};

type QiniuBucketManager = {
  delete(bucket: string, key: string): Promise<QiniuResponse>;
  publicDownloadUrl(domain: string, key: string): string;
  privateDownloadUrl(domain: string, key: string, deadline: number): string;
};

type QiniuStorageDependencies = {
  uploader: QiniuUploader;
  bucketManager: QiniuBucketManager;
  createUploadToken(bucket: string, key: string, fileSize: number): string;
};

const STORAGE_REFERENCE_PREFIX = 'qiniu://';

export function createStorageReference(scope: QiniuStorageScope, key: string) {
  return `${STORAGE_REFERENCE_PREFIX}${scope}/${key}`;
}

export function parseStorageReference(value: string) {
  if (!value.startsWith(STORAGE_REFERENCE_PREFIX)) return null;
  const separatorIndex = value.indexOf('/', STORAGE_REFERENCE_PREFIX.length);
  if (separatorIndex === -1) return null;

  const scope = value.slice(STORAGE_REFERENCE_PREFIX.length, separatorIndex);
  const key = value.slice(separatorIndex + 1);
  if ((scope !== 'public' && scope !== 'private') || !key) return null;
  return { scope, key } as { scope: QiniuStorageScope; key: string };
}

export function buildObjectKey(
  purpose: UploadPurpose,
  originalFilename: string,
  now = new Date(),
  id = uuidv4(),
) {
  const extension = path.extname(originalFilename).toLowerCase();
  const safeExtension = /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : '';
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${purpose}/${year}/${month}/${id}${safeExtension}`;
}

export class QiniuStorageService {
  private readonly dependencies: QiniuStorageDependencies;

  constructor(
    private readonly config: QiniuStorageConfig,
    dependencies?: QiniuStorageDependencies,
  ) {
    if (dependencies) {
      this.dependencies = dependencies;
      return;
    }

    const mac = new qiniu.auth.digest.Mac(config.accessKey, config.secretKey);
    const sdkConfig = new qiniu.conf.Config({ useHttpsDomain: true });
    this.dependencies = {
      uploader: new qiniu.form_up.FormUploader(sdkConfig),
      bucketManager: new qiniu.rs.BucketManager(mac, sdkConfig),
      createUploadToken(bucket, key, fileSize) {
        return new qiniu.rs.PutPolicy({
          scope: `${bucket}:${key}`,
          fsizeLimit: fileSize,
          detectMime: 1,
        }).uploadToken(mac);
      },
    };
  }

  async uploadFile(
    localFile: string,
    key: string,
    scope: QiniuStorageScope,
    mimeType: string,
    fileSize: number,
  ) {
    const bucket = this.getBucket(scope);
    const uploadToken = this.dependencies.createUploadToken(bucket, key, fileSize);
    const response = await this.dependencies.uploader.putFile(
      uploadToken,
      key,
      localFile,
      new qiniu.form_up.PutExtra('', {}, mimeType),
    );

    if (!response.ok()) {
      throw new Error(response.data?.error || '七牛云上传失败');
    }

    const storageRef = createStorageReference(scope, key);
    return {
      key,
      scope,
      storageRef,
      fileUrl: this.resolveUrl(storageRef),
    };
  }

  resolveUrl(value: string) {
    const reference = parseStorageReference(value);
    if (!reference) return value;

    if (reference.scope === 'public') {
      return this.dependencies.bucketManager.publicDownloadUrl(
        this.config.publicDomain,
        reference.key,
      );
    }

    const deadline = Math.floor(Date.now() / 1000) + this.config.signedUrlExpires;
    return this.dependencies.bucketManager.privateDownloadUrl(
      this.config.privateDomain,
      reference.key,
      deadline,
    );
  }

  async deleteFile(storageRef: string) {
    const reference = parseStorageReference(storageRef);
    if (!reference) throw new Error('七牛云文件引用无效');

    const response = await this.dependencies.bucketManager.delete(
      this.getBucket(reference.scope),
      reference.key,
    );
    if (!response.ok()) {
      throw new Error(response.data?.error || '七牛云文件删除失败');
    }
  }

  private getBucket(scope: QiniuStorageScope) {
    return scope === 'public' ? this.config.publicBucket : this.config.privateBucket;
  }
}

export const qiniuStorage = new QiniuStorageService({
  ...env.qiniu,
  ...qiniuStorageConfig,
});

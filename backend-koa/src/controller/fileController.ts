import { Context } from 'koa';
import { File, User } from '../models';
import fs from 'fs/promises';
import path from 'path';
import {
  buildObjectKey,
  parseStorageReference,
  qiniuStorage,
  type UploadPurpose,
} from '../services/qiniuStorageService';

/**
 * 上传文件
 */
export async function uploadFile(ctx: Context) {
  let temporaryFilePath: string | undefined;
  let uploadedStorageRef: string | undefined;
  try {
    const userId = ctx.state.user?.userId;
    const { groupId, purpose = 'file' } = ctx.request.body as {
      groupId?: string;
      purpose?: UploadPurpose;
    };
    const file = ctx.request.files?.file;

    if (!file || Array.isArray(file)) {
      ctx.status = 400;
      ctx.body = { error: '请选择一个文件' };
      return;
    }

    if (!['avatar', 'chat', 'file'].includes(purpose)) {
      ctx.status = 400;
      ctx.body = { error: '文件用途无效' };
      return;
    }
    if (purpose === 'avatar' && !file.mimetype?.startsWith('image/')) {
      ctx.status = 400;
      ctx.body = { error: '头像必须是图片文件' };
      return;
    }

    temporaryFilePath = file.filepath;
    const originalName = file.originalFilename || 'file';
    const scope = purpose === 'avatar' ? 'public' : 'private';
    const objectKey = buildObjectKey(purpose, originalName);
    const uploaded = await qiniuStorage.uploadFile(
      temporaryFilePath,
      objectKey,
      scope,
      file.mimetype || 'application/octet-stream',
      file.size,
    );
    uploadedStorageRef = uploaded.storageRef;

    // 保存文件记录
    const fileRecord = await File.create({
      userId,
      groupId: groupId ? parseInt(groupId) : undefined,
      fileName: path.basename(objectKey),
      originalName,
      fileSize: file.size,
      mimeType: file.mimetype || 'application/octet-stream',
      filePath: objectKey,
      fileUrl: uploaded.storageRef,
    });
    uploadedStorageRef = undefined;

    ctx.body = {
      message: '文件上传成功',
      file: {
        id: fileRecord.id,
        originalName: fileRecord.originalName,
        fileSize: fileRecord.fileSize,
        mimeType: fileRecord.mimeType,
        fileUrl: uploaded.fileUrl,
        createdAt: fileRecord.createdAt,
      },
    };
  } catch (error: any) {
    console.error('文件上传失败:', error);
    if (uploadedStorageRef) {
      await qiniuStorage.deleteFile(uploadedStorageRef).catch((cleanupError) => {
        console.error('清理未入库的七牛对象失败:', cleanupError);
      });
    }
    ctx.status = 500;
    ctx.body = { error: '文件上传失败: ' + error.message };
  } finally {
    if (temporaryFilePath) {
      await fs.unlink(temporaryFilePath).catch(() => undefined);
    }
  }
}

/**
 * 获取文件列表
 */
export async function getFiles(ctx: Context) {
  try {
    const userId = ctx.state.user?.userId;
    const { groupId, limit = 50, offset = 0 } = ctx.query;

    const whereClause: any = {};

    if (groupId) {
      whereClause.groupId = parseInt(groupId as string);
    } else {
      whereClause.userId = userId;
    }

    const files = await File.findAll({
      where: whereClause,
      include: [
        {
          model: User,
          as: 'uploader',
          attributes: ['id', 'username', 'nickname', 'avatar'],
        },
      ],
      order: [['createdAt', 'DESC']],
      limit: parseInt(limit as string),
      offset: parseInt(offset as string),
    });

    ctx.body = {
      files: files.map((file) => ({
        ...file.toJSON(),
        fileUrl: qiniuStorage.resolveUrl(file.fileUrl),
      })),
      hasMore: files.length === parseInt(limit as string),
    };
  } catch (error: any) {
    console.error('获取文件列表失败:', error);
    ctx.status = 500;
    ctx.body = { error: '获取文件列表失败: ' + error.message };
  }
}

/**
 * 下载文件
 */
export async function downloadFile(ctx: Context) {
  try {
    const { fileId } = ctx.params;

    const file = await File.findByPk(parseInt(fileId));
    if (!file) {
      ctx.status = 404;
      ctx.body = { error: '文件不存在' };
      return;
    }

    // 更新下载次数
    await file.update({ downloadCount: file.downloadCount + 1 });

    if (parseStorageReference(file.fileUrl)) {
      ctx.redirect(qiniuStorage.resolveUrl(file.fileUrl));
      return;
    }

    // 迁移完成前继续兼容历史 uploads 文件。
    try {
      await fs.access(file.filePath);
    } catch {
      ctx.status = 404;
      ctx.body = { error: '文件已被删除' };
      return;
    }

    // 设置响应头
    ctx.set('Content-Type', file.mimeType);
    ctx.set(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(file.originalName)}"`,
    );
    ctx.set('Content-Length', file.fileSize.toString());

    // 读取并返回文件
    ctx.body = await fs.readFile(file.filePath);
  } catch (error: any) {
    console.error('下载文件失败:', error);
    ctx.status = 500;
    ctx.body = { error: '下载文件失败: ' + error.message };
  }
}

/**
 * 删除文件
 */
export async function deleteFile(ctx: Context) {
  try {
    const userId = ctx.state.user?.userId;
    const { fileId } = ctx.params;

    const file = await File.findByPk(parseInt(fileId));
    if (!file) {
      ctx.status = 404;
      ctx.body = { error: '文件不存在' };
      return;
    }

    // 检查权限
    if (file.userId !== userId) {
      ctx.status = 403;
      ctx.body = { error: '无权删除此文件' };
      return;
    }

    if (parseStorageReference(file.fileUrl)) {
      await qiniuStorage.deleteFile(file.fileUrl);
    } else {
      try {
        await fs.unlink(file.filePath);
      } catch (error: any) {
        if (error.code !== 'ENOENT') throw error;
      }
    }

    // 删除数据库记录
    await file.destroy();

    ctx.body = { message: '文件删除成功' };
  } catch (error: any) {
    console.error('删除文件失败:', error);
    ctx.status = 500;
    ctx.body = { error: '删除文件失败: ' + error.message };
  }
}

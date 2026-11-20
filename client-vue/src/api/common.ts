import { request } from '@/utils/request';

// router.post('/upload', authMiddleware, fileController.uploadFile);
// router.get('/', authMiddleware, fileController.getFiles);
// router.get('/:fileId/download', authMiddleware, fileController.downloadFile);
// router.delete('/:fileId', authMiddleware, fileController.deleteFile);

export interface FileInfo {
  id: number;
  originalName: string;
  fileSize: number;
  mimeType: string;
  fileUrl: string;
  createdAt: string;
}
/**
 * 上传文件
 */
export function uploadFile(files: FormData, signal?: AbortSignal) {
  return request<{ message: string; file: FileInfo }>('/api/files/upload', {
    method: 'POST',
    body: files,
    signal,
  });
}

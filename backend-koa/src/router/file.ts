import Router from 'koa-router';
import * as fileController from '../controller/fileController';
import { authMiddleware } from '../middleware/auth';

const router = new Router({ prefix: '/api/files' });

// 所有路由都需要认证
router.post('/upload', authMiddleware, fileController.uploadFile);
router.get('/', authMiddleware, fileController.getFiles);
router.get('/:fileId/download', authMiddleware, fileController.downloadFile);
router.delete('/:fileId', authMiddleware, fileController.deleteFile);

export default router;

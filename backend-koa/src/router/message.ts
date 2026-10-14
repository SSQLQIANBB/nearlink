import Router from 'koa-router';
import * as messageController from '../controller/messageController';
import { authMiddleware } from '../middleware/auth';

const router = new Router({ prefix: '/api/messages' });

// 所有路由都需要认证
router.get('/offline', authMiddleware, messageController.getOfflineMessages);
router.post('/mark-read', authMiddleware, messageController.markMessagesAsRead);
router.get('/unread-count', authMiddleware, messageController.getUnreadCount);
router.get('/group-cursors', authMiddleware, messageController.getGroupCursors);

// 历史消息
router.get('/private', authMiddleware, messageController.getPrivateMessages);
router.get('/group/:groupId', authMiddleware, messageController.getGroupMessages);
router.post('/group', authMiddleware, messageController.saveGroupMessage);

// 搜索消息
router.get('/search', authMiddleware, messageController.searchMessages);

export default router;

import Router from 'koa-router';
import * as invitationController from '../controller/invitationController';
import { authMiddleware } from '../middleware/auth';

const router = new Router({ prefix: '/api/invitations' });

// 所有路由都需要认证
router.get('/', authMiddleware, invitationController.getPendingInvitations);
router.post('/:invitationId/accept', authMiddleware, invitationController.acceptInvitation);
router.post('/:invitationId/reject', authMiddleware, invitationController.rejectInvitation);

export default router;

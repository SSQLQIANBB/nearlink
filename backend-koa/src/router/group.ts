import Router from 'koa-router';
import * as groupController from '../controller/groupController';
import { authMiddleware } from '../middleware/auth';

const router = new Router({ prefix: '/api/groups' });

// 所有群组路由都需要认证
router.use(authMiddleware);

router.post('/', groupController.createGroup);
router.get('/my', groupController.getMyGroups);
router.get('/:id', groupController.getGroupDetail);
router.put('/:id', groupController.updateGroup);
router.delete('/:id', groupController.deleteGroup);
router.post('/:id/invite', groupController.inviteToGroup);
router.post('/:id/permission', groupController.setMemberPermission);
router.delete('/:id/leave', groupController.leaveGroup);

export default router;

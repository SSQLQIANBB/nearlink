import { Context } from 'koa';
import { GroupInvitation, Group, User, GroupMember } from '../models';

/**
 * 获取待处理的群组邀请
 */
export async function getPendingInvitations(ctx: Context) {
  try {
    const userId = ctx.state.user?.userId;

    const invitations = await GroupInvitation.findAll({
      where: { inviteeId: userId, status: 'pending' },
      include: [
        {
          model: Group,
          as: 'group',
          attributes: ['id', 'name', 'description', 'avatar', 'ownerId'],
        },
        {
          model: User,
          as: 'inviter',
          attributes: ['id', 'username', 'nickname', 'avatar'],
        },
      ],
      order: [['createdAt', 'DESC']],
    });

    ctx.body = { invitations };
  } catch (error: any) {
    console.error('获取群组邀请失败:', error);
    ctx.status = 500;
    ctx.body = { error: '获取群组邀请失败: ' + error.message };
  }
}

/**
 * 接受群组邀请
 */
export async function acceptInvitation(ctx: Context) {
  try {
    const userId = ctx.state.user?.userId;
    const { invitationId } = ctx.params;

    const invitation = await GroupInvitation.findOne({
      where: { id: invitationId, inviteeId: userId, status: 'pending' },
    });

    if (!invitation) {
      ctx.status = 404;
      ctx.body = { error: '邀请不存在或已处理' };
      return;
    }

    // 检查用户是否已经是群成员
    const existingMember = await GroupMember.findOne({
      where: { groupId: invitation.groupId, userId },
    });

    if (existingMember) {
      // 更新邀请状态
      await invitation.update({ status: 'accepted' });
      ctx.body = { message: '您已经是该群组的成员' };
      return;
    }

    // 添加为群成员
    await GroupMember.create({
      groupId: invitation.groupId,
      userId,
      role: 'member',
      canSpeak: true,
    });

    // 更新邀请状态
    await invitation.update({ status: 'accepted' });

    ctx.body = { message: '成功加入群组' };
  } catch (error: any) {
    console.error('接受邀请失败:', error);
    ctx.status = 500;
    ctx.body = { error: '接受邀请失败: ' + error.message };
  }
}

/**
 * 拒绝群组邀请
 */
export async function rejectInvitation(ctx: Context) {
  try {
    const userId = ctx.state.user?.userId;
    const { invitationId } = ctx.params;

    const invitation = await GroupInvitation.findOne({
      where: { id: invitationId, inviteeId: userId, status: 'pending' },
    });

    if (!invitation) {
      ctx.status = 404;
      ctx.body = { error: '邀请不存在或已处理' };
      return;
    }

    await invitation.update({ status: 'rejected' });

    ctx.body = { message: '已拒绝邀请' };
  } catch (error: any) {
    console.error('拒绝邀请失败:', error);
    ctx.status = 500;
    ctx.body = { error: '拒绝邀请失败: ' + error.message };
  }
}

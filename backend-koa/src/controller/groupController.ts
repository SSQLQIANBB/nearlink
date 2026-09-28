import { Context } from 'koa';
import { runGroupOperation, revokeGroupAccess } from '../services/groupAccessCoordinator';
import { Group, GroupMember, User, GroupInvitation, GroupMessage } from '../models';
import sequelize from '../config/database';
import redisService from '../services/redisService';
import {
  GroupDeletionError,
  GroupDeletionService,
} from '../services/groupDeletionService';

/**
 * 创建群组
 */
export async function createGroup(ctx: Context) {
  try {
    const userId = ctx.state.user?.userId;
    const { name, description, avatar } = ctx.request.body as any;

    if (!name) {
      ctx.status = 400;
      ctx.body = { error: '群组名称不能为空' };
      return;
    }

    // 创建群组
    const group = await Group.create({
      name,
      description,
      avatar,
      ownerId: userId,
    });

    // 添加创建者为群主
    await GroupMember.create({
      groupId: group.id!,
      userId,
      role: 'owner',
      canSpeak: true,
    });

    ctx.body = {
      message: '创建群组成功',
      group: {
        id: group.id,
        name: name,
        description: description,
        avatar: avatar || null,
        ownerId: userId,
      },
    };
  } catch (error: any) {
    console.error('创建群组失败:', error);
    ctx.status = 500;
    ctx.body = { error: '创建群组失败: ' + error.message };
  }
}

/**
 * 获取我的群组列表
 */
export async function getMyGroups(ctx: Context) {
  try {
    const userId = ctx.state.user?.userId;

    const groupMembers = await GroupMember.findAll({
      where: { userId },
      include: [
        {
          model: Group,
          as: 'group',
        },
      ],
    });

    const groups = await Promise.all(
      groupMembers.map(async (gm: any) => {
        const gmData = gm.get({ plain: true });
        const memberCount = await GroupMember.count({
          where: { groupId: gmData.groupId },
        });

        return {
          id: gmData.group.id,
          name: gmData.group.name,
          description: gmData.group.description,
          avatar: gmData.group.avatar,
          ownerId: gmData.group.ownerId,
          role: gmData.role,
          canSpeak: gmData.canSpeak,
          memberCount,
        };
      })
    );

    ctx.body = { groups };
  } catch (error: any) {
    console.error('获取群组列表失败:', error);
    ctx.status = 500;
    ctx.body = { error: '获取群组列表失败: ' + error.message };
  }
}

/**
 * 获取群组详情
 */
export async function getGroupDetail(ctx: Context) {
  try {
    const groupId = parseInt(ctx.params.id);
    const userId = ctx.state.user?.userId;

    // 检查用户是否是群成员
    const member = await GroupMember.findOne({
      where: { groupId, userId },
    });

    if (!member) {
      ctx.status = 403;
      ctx.body = { error: '您不是该群组成员' };
      return;
    }

    const group = await Group.findByPk(groupId);
    if (!group) {
      ctx.status = 404;
      ctx.body = { error: '群组不存在' };
      return;
    }

    // 获取群成员列表
    const members = await GroupMember.findAll({
      where: { groupId },
      include: [
        {
          model: User,
          as: 'user',
          attributes: ['id', 'username', 'nickname', 'avatar', 'status'],
        },
      ],
    });

    const groupData = group.get({ plain: true });
    const memberData = member.get({ plain: true });

    ctx.body = {
      group: {
        id: groupData.id,
        name: groupData.name,
        description: groupData.description,
        avatar: groupData.avatar,
        ownerId: groupData.ownerId,
      },
      members: members.map((m: any) => {
        const mData = m.get({ plain: true });
        return {
          id: mData.user.id,
          username: mData.user.username,
          nickname: mData.user.nickname,
          avatar: mData.user.avatar,
          status: mData.user.status,
          role: mData.role,
          canSpeak: mData.canSpeak,
        };
      }),
      myRole: memberData.role,
      myCanSpeak: memberData.canSpeak,
    };
  } catch (error: any) {
    console.error('获取群组详情失败:', error);
    ctx.status = 500;
    ctx.body = { error: '获取群组详情失败: ' + error.message };
  }
}

/**
 * 邀请用户加入群组
 */
export async function inviteToGroup(ctx: Context) {
  try {
    const groupId = parseInt(ctx.params.id);
    const userId = ctx.state.user?.userId;
    const { userIds } = ctx.request.body as any;

    if (!Array.isArray(userIds) || userIds.length === 0) {
      ctx.status = 400;
      ctx.body = { error: '请选择要邀请的用户' };
      return;
    }

    // 检查是否有权限邀请
    const member = await GroupMember.findOne({
      where: { groupId, userId },
    });

    if (!member) {
      ctx.status = 403;
      ctx.body = { error: '您不是该群组成员' };
      return;
    }

    // 只有群主和管理员可以邀请（如果需要严格权限）
    // 如果允许所有成员邀请，可以注释掉以下检查
    // if (member.role !== 'owner' && member.role !== 'admin') {
    //   ctx.status = 403;
    //   ctx.body = { error: '您没有权限邀请用户' };
    //   return;
    // }

    // 创建邀请记录
    const results = await Promise.all(
      userIds.map(async (inviteUserId: number) => {
        const existingMember = await GroupMember.findOne({
          where: { groupId, userId: inviteUserId },
        });

        if (existingMember) {
          return { userId: inviteUserId, success: false, message: '用户已在群组中' };
        }

        // 检查是否已有待处理的邀请
        const existingInvitation = await GroupInvitation.findOne({
          where: { groupId, inviteeId: inviteUserId, status: 'pending' },
        });

        if (existingInvitation) {
          return { userId: inviteUserId, success: false, message: '已有待处理的邀请' };
        }

        // 创建邀请记录
        await GroupInvitation.create({
          groupId,
          inviterId: userId,
          inviteeId: inviteUserId,
          status: 'pending',
        });

        return { userId: inviteUserId, success: true, message: '邀请已发送' };
      })
    );

    ctx.body = {
      message: '邀请已发送',
      results,
    };
  } catch (error: any) {
    console.error('邀请用户失败:', error);
    ctx.status = 500;
    ctx.body = { error: '邀请用户失败: ' + error.message };
  }
}

/**
 * 设置成员发言权限
 */
async function setMemberPermissionLocked(ctx: Context) {
  try {
    const groupId = parseInt(ctx.params.id);
    const userId = ctx.state.user?.userId;
    const { targetUserId, canSpeak } = ctx.request.body as any;
    if (!Number.isSafeInteger(targetUserId) || targetUserId <= 0 || typeof canSpeak !== 'boolean') {
      ctx.status = 400; ctx.body = { error: '无效的成员权限' }; return;
    }

    // 检查是否有权限
    const member = await GroupMember.findOne({
      where: { groupId, userId },
    });

    if (!member || member.role !== 'owner') {
      ctx.status = 403;
      ctx.body = { error: '只有群主可以设置成员权限' };
      return;
    }

    // 更新目标用户权限
    const targetMember = await GroupMember.findOne({
      where: { groupId, userId: targetUserId },
    });

    if (!targetMember) {
      ctx.status = 404;
      ctx.body = { error: '用户不在群组中' };
      return;
    }

    await targetMember.update({ canSpeak });

    ctx.body = {
      message: '权限设置成功',
    };
  } catch (error: any) {
    console.error('设置权限失败:', error);
    ctx.status = 500;
    ctx.body = { error: '设置权限失败: ' + error.message };
  }
}

/**
 * 更新群组信息
 */
export async function updateGroup(ctx: Context) {
  try {
    const groupId = parseInt(ctx.params.id);
    const userId = ctx.state.user?.userId;
    const { name, description, avatar } = ctx.request.body as any;

    // 检查是否有权限
    const member = await GroupMember.findOne({
      where: { groupId, userId },
    });

    if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
      ctx.status = 403;
      ctx.body = { error: '您没有权限修改群组信息' };
      return;
    }

    const group = await Group.findByPk(groupId);
    if (!group) {
      ctx.status = 404;
      ctx.body = { error: '群组不存在' };
      return;
    }

    await group.update({
      ...(name && { name }),
      ...(description && { description }),
      ...(avatar && { avatar }),
    });

    const groupData = group.get({ plain: true });

    ctx.body = {
      message: '更新成功',
      group: {
        id: groupData.id,
        name: groupData.name,
        description: groupData.description,
        avatar: groupData.avatar,
      },
    };
  } catch (error: any) {
    console.error('更新群组失败:', error);
    ctx.status = 500;
    ctx.body = { error: '更新群组失败: ' + error.message };
  }
}

/**
 * 退出群组
 */
async function leaveGroupLocked(ctx: Context) {
  try {
    const groupId = parseInt(ctx.params.id);
    const userId = ctx.state.user?.userId;

    const member = await GroupMember.findOne({
      where: { groupId, userId },
    });

    if (!member) {
      ctx.status = 404;
      ctx.body = { error: '您不在该群组中' };
      return;
    }

    if (member.role === 'owner') {
      ctx.status = 400;
      ctx.body = { error: '群主不能退出群组，请先转让群主' };
      return;
    }

    await member.destroy();
    await revokeGroupAccess({ groupId, userId, reason: 'left' });

    ctx.body = { message: '已退出群组' };
  } catch (error: any) {
    console.error('退出群组失败:', error);
    ctx.status = 500;
    ctx.body = { error: '退出群组失败: ' + error.message };
  }
}

/**
 * 删除群组
 */
async function deleteGroupLocked(ctx: Context) {
  const groupId = parseInt(ctx.params.id);
  const userId = ctx.state.user?.userId;

  if (!Number.isInteger(groupId) || !userId) {
    ctx.status = 400;
    ctx.body = { error: '无效的群组ID' };
    return;
  }

  const service = new GroupDeletionService({
    findMembership: (id, memberUserId) => GroupMember.findOne({
      where: { groupId: id, userId: memberUserId },
    }),
    findGroup: id => Group.findByPk(id),
    transaction: callback => sequelize.transaction(transaction => callback(transaction)),
    deleteMessages: (id, transaction) => GroupMessage.destroy({
      where: { groupId: id },
      transaction: transaction as any,
    }),
    deleteInvitations: (id, transaction) => GroupInvitation.destroy({
      where: { groupId: id },
      transaction: transaction as any,
    }),
    deleteMembers: (id, transaction) => GroupMember.destroy({
      where: { groupId: id },
      transaction: transaction as any,
    }),
    deleteGroup: (id, transaction) => Group.destroy({
      where: { id },
      transaction: transaction as any,
    }),
  });

  try {
    await service.delete(groupId, userId);
    await revokeGroupAccess({ groupId, reason: 'deleted' });

    // 数据库删除已经成功时，缓存清理失败只记录日志，避免向客户端返回伪失败。
    try {
      await Promise.all([
        redisService.delGroupInfo(groupId),
        redisService.delGroupMembers(groupId),
        redisService.delPattern(`group:session:${groupId}:*`),
      ]);
    } catch (error) {
      console.error('删除群组后的缓存清理失败:', error);
    }

    ctx.body = { message: '群组已删除' };
  } catch (error: any) {
    if (error instanceof GroupDeletionError) {
      ctx.status = error.status;
      ctx.body = { error: error.message };
      return;
    }

    console.error('删除群组失败:', error);
    ctx.status = 500;
    ctx.body = { error: '删除群组失败: ' + error.message };
  }
}


export async function leaveGroup(ctx: Context) {
  const groupId = Number(ctx.params.id);
  if (!Number.isSafeInteger(groupId) || groupId <= 0) {
    ctx.status = 400; ctx.body = { error: '无效的群组ID' }; return;
  }
  await runGroupOperation(groupId, () => leaveGroupLocked(ctx));
}

export async function deleteGroup(ctx: Context) {
  const groupId = Number(ctx.params.id);
  if (!Number.isSafeInteger(groupId) || groupId <= 0) {
    ctx.status = 400; ctx.body = { error: '无效的群组ID' }; return;
  }
  await runGroupOperation(groupId, () => deleteGroupLocked(ctx));
}

export async function setMemberPermission(ctx: Context) {
  const groupId = Number(ctx.params.id);
  if (!Number.isSafeInteger(groupId) || groupId <= 0) {
    ctx.status = 400; ctx.body = { error: '无效的群组ID' }; return;
  }
  await runGroupOperation(groupId, () => setMemberPermissionLocked(ctx));
}

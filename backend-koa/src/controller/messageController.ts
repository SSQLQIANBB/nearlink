import { visibleMessages } from '../services/messageActions';
import { Context } from 'koa';
import { Op, fn, col } from 'sequelize';
import { GroupMember, GroupMessage, Message, User } from '../models';
import { serializeChatMessage } from '../services/callHistoryService';

const MESSAGE_CACHE_DAYS = 30;

function getMessageCacheStartDate() {
  return new Date(Date.now() - MESSAGE_CACHE_DAYS * 24 * 60 * 60 * 1000);
}

export async function getOfflineMessages(ctx: Context) {
  try {
    const userId = ctx.state.user?.userId;

    const messages = await Message.findAll({
      where: {
        id: visibleMessages(userId, 'private'),
        toUserId: userId,
        isRead: false,
        createdAt: { [Op.gte]: getMessageCacheStartDate() },
      },
      include: [
        {
          model: User,
          as: 'sender',
          attributes: ['id', 'username', 'nickname', 'avatar'],
        },
      ],
      order: [['createdAt', 'ASC']],
    });

    ctx.body = { messages: messages.map(serializeChatMessage) };
  } catch (error: any) {
    console.error('get offline messages failed:', error);
    ctx.status = 500;
    ctx.body = { error: `Get offline messages failed: ${error.message}` };
  }
}

export async function markMessagesAsRead(ctx: Context) {
  try {
    const userId = ctx.state.user?.userId;
    const { messageIds } = ctx.request.body as any;

    if (!Array.isArray(messageIds)) {
      ctx.status = 400;
      ctx.body = { error: 'messageIds must be an array' };
      return;
    }

    await Message.update(
      { isRead: true },
      {
        where: {
          id: messageIds,
          toUserId: userId,
        },
      },
    );

    ctx.body = { message: 'Messages marked as read' };
  } catch (error: any) {
    console.error('mark messages as read failed:', error);
    ctx.status = 500;
    ctx.body = { error: `Mark messages as read failed: ${error.message}` };
  }
}

export async function getUnreadCount(ctx: Context) {
  try {
    const userId = ctx.state.user?.userId;

    const count = await Message.count({
      where: {
        id: visibleMessages(userId, 'private'),
        toUserId: userId,
        isRead: false,
        createdAt: { [Op.gte]: getMessageCacheStartDate() },
      },
    });

    ctx.body = { count };
  } catch (error: any) {
    console.error('get unread count failed:', error);
    ctx.status = 500;
    ctx.body = { error: `Get unread count failed: ${error.message}` };
  }
}

export async function getPrivateMessages(ctx: Context) {
  try {
    const userId = ctx.state.user?.userId;
    const { contactUserId, limit = 50, offset = 0 } = ctx.query;
    const contactId = Number(contactUserId);

    if (!contactId) {
      ctx.status = 400;
      ctx.body = { error: 'contactUserId is required' };
      return;
    }

    const messages = await Message.findAll({
      where: {
        id: visibleMessages(userId, 'private'),
        createdAt: { [Op.gte]: getMessageCacheStartDate() },
        [Op.or]: [
          { fromUserId: userId, toUserId: contactId },
          { fromUserId: contactId, toUserId: userId },
        ],
      },
      include: [
        {
          model: User,
          as: 'sender',
          attributes: ['id', 'username', 'nickname', 'avatar'],
        },
        {
          model: User,
          as: 'receiver',
          attributes: ['id', 'username', 'nickname', 'avatar'],
        },
      ],
      order: [['createdAt', 'DESC']],
      limit: Number(limit),
      offset: Number(offset),
    });

    ctx.body = {
      messages: messages.reverse().map(serializeChatMessage),
      hasMore: messages.length === Number(limit),
    };
  } catch (error: any) {
    console.error('get private messages failed:', error);
    ctx.status = 500;
    ctx.body = { error: `Get private messages failed: ${error.message}` };
  }
}

export async function getGroupMessages(ctx: Context) {
  try {
    const { groupId } = ctx.params;
    const { limit = 50, offset = 0, search, afterId } = ctx.query;
    const parsedGroupId = Number(groupId);
    const parsedLimit = Math.min(100, Math.max(1, Number(limit) || 50));
    const parsedOffset = Math.max(0, Number(offset) || 0);
    if (
      !Number.isInteger(parsedGroupId) ||
      parsedGroupId < 1 ||
      (afterId !== undefined && (!Number.isSafeInteger(Number(afterId)) || Number(afterId) < 0))
    ) {
      ctx.status = 400;
      ctx.body = { error: '群组或游标无效' };
      return;
    }
    const member = await GroupMember.findOne({
      where: { groupId: parsedGroupId, userId: ctx.state.user.userId },
    });
    if (!member) {
      ctx.status = 403;
      ctx.body = { error: '不是群组成员' };
      return;
    }

    const whereClause: any = {
      groupId: parsedGroupId,
      id: visibleMessages(ctx.state.user.userId, 'group'),
    };
    if (afterId !== undefined)
      whereClause.id = {
        ...visibleMessages(ctx.state.user.userId, 'group'),
        [Op.gt]: Number(afterId),
      };
    else whereClause.createdAt = { [Op.gte]: getMessageCacheStartDate() };

    if (search) {
      whereClause.message = {
        [Op.like]: `%${search}%`,
      };
    }

    const messages = await GroupMessage.findAll({
      where: whereClause,
      include: [
        {
          model: User,
          as: 'sender',
          attributes: ['id', 'username', 'nickname', 'avatar'],
        },
      ],
      order: afterId !== undefined ? [['id', 'ASC']] : [['id', 'DESC']],
      limit: parsedLimit + 1,
      offset: afterId !== undefined ? 0 : parsedOffset,
    });

    const hasMore = messages.length > parsedLimit;
    const page = messages.slice(0, parsedLimit);
    ctx.body = {
      messages: (afterId !== undefined ? page : page.reverse()).map(serializeChatMessage),
      hasMore,
    };
  } catch (error: any) {
    console.error('get group messages failed:', error);
    ctx.status = 500;
    ctx.body = { error: `Get group messages failed: ${error.message}` };
  }
}

export async function getGroupCursors(ctx: Context) {
  try {
    const memberships = await GroupMember.findAll({
      where: { userId: ctx.state.user.userId },
      attributes: ['groupId'],
    });
    const groupIds = memberships.map((member) => member.groupId);
    if (!groupIds.length) {
      ctx.body = { cursors: {} };
      return;
    }
    const rows = await GroupMessage.findAll({
      attributes: ['groupId', [fn('MAX', col('id')), 'latestId']],
      where: { groupId: { [Op.in]: groupIds } },
      group: ['groupId'],
      raw: true,
    });
    const cursors: Record<number, number> = {};
    for (const row of rows as any[]) cursors[row.groupId] = Number(row.latestId) || 0;
    ctx.body = { cursors };
  } catch (error) {
    console.error('get group cursors failed:', error);
    ctx.status = 500;
    ctx.body = { error: '获取群消息游标失败' };
  }
}

export async function saveGroupMessage(ctx: Context) {
  try {
    const userId = ctx.state.user?.userId;
    const {
      groupId,
      message,
      messageType = 'text',
      fileUrl,
      fileName,
      fileSize,
    } = ctx.request.body as any;

    if (
      !groupId ||
      typeof message !== 'string' ||
      !message.trim() ||
      message.trim().startsWith('__NEARLINK_REPLY__:')
    ) {
      ctx.status = 400;
      ctx.body = { error: 'groupId and message are required' };
      return;
    }

    const groupMessage = await GroupMessage.create({
      groupId,
      userId,
      message,
      messageType,
      fileUrl,
      fileName,
      fileSize,
    });

    const savedMessage = await GroupMessage.findByPk(groupMessage.id, {
      include: [
        {
          model: User,
          as: 'sender',
          attributes: ['id', 'username', 'nickname', 'avatar'],
        },
      ],
    });

    ctx.body = {
      message: 'Message saved',
      data: savedMessage,
    };
  } catch (error: any) {
    console.error('save group message failed:', error);
    ctx.status = 500;
    ctx.body = { error: `Save group message failed: ${error.message}` };
  }
}

export async function searchMessages(ctx: Context) {
  try {
    const userId = ctx.state.user?.userId;
    const { keyword, type = 'all', limit = 20 } = ctx.query;

    if (!keyword) {
      ctx.status = 400;
      ctx.body = { error: 'keyword is required' };
      return;
    }

    const results: any = {
      privateMessages: [],
      groupMessages: [],
    };

    if (type === 'all' || type === 'private') {
      results.privateMessages = await Message.findAll({
        where: {
          id: visibleMessages(userId, 'private'),
          createdAt: { [Op.gte]: getMessageCacheStartDate() },
          [Op.or]: [{ fromUserId: userId }, { toUserId: userId }],
          message: {
            [Op.like]: `%${keyword}%`,
          },
        },
        include: [
          {
            model: User,
            as: 'sender',
            attributes: ['id', 'username', 'nickname', 'avatar'],
          },
          {
            model: User,
            as: 'receiver',
            attributes: ['id', 'username', 'nickname', 'avatar'],
          },
        ],
        order: [['createdAt', 'DESC']],
        limit: Number(limit),
      });
    }

    if (type === 'all' || type === 'group') {
      const memberships = await GroupMember.findAll({ where: { userId } });
      results.groupMessages = await GroupMessage.findAll({
        where: {
          id: visibleMessages(userId, 'group'),
          groupId: { [Op.in]: memberships.map((member) => member.groupId) },
          createdAt: { [Op.gte]: getMessageCacheStartDate() },
          message: {
            [Op.like]: `%${keyword}%`,
          },
        },
        include: [
          {
            model: User,
            as: 'sender',
            attributes: ['id', 'username', 'nickname', 'avatar'],
          },
        ],
        order: [['createdAt', 'DESC']],
        limit: Number(limit),
      });
    }

    ctx.body = {
      privateMessages: results.privateMessages.map(serializeChatMessage),
      groupMessages: results.groupMessages.map(serializeChatMessage),
    };
  } catch (error: any) {
    console.error('search messages failed:', error);
    ctx.status = 500;
    ctx.body = { error: `Search messages failed: ${error.message}` };
  }
}

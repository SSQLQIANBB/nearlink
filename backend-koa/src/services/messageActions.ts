import { Op, literal } from 'sequelize';
import { GroupMember, GroupMessage, Message, User } from '../models';
import MessageDeletion from '../models/MessageDeletion';
import { serializeChatMessage } from './callHistoryService';
import { encodeReply } from './messageQuote';

export type MessageReference = { kind: 'private' | 'group'; id: number };
export function visibleMessages(userId: number, kind: MessageReference['kind']) {
  if (!Number.isSafeInteger(userId) || userId < 1) throw new Error('账号无效');
  return {
    [Op.notIn]: literal(
      `(SELECT messageId FROM message_deletions WHERE userId = ${userId} AND kind = '${kind}')`,
    ),
  };
}
export async function accessibleMessage(userId: number, ref: MessageReference) {
  if (
    !ref ||
    !['private', 'group'].includes(ref.kind) ||
    !Number.isSafeInteger(ref.id) ||
    ref.id < 1
  )
    throw new Error('消息标识无效');
  const record =
    ref.kind === 'private' ? await Message.findByPk(ref.id) : await GroupMessage.findByPk(ref.id);
  if (!record) throw new Error('消息不存在');
  if (record instanceof Message) {
    if (record.fromUserId !== userId && record.toUserId !== userId)
      throw new Error('无消息访问权限');
  } else if (!(await GroupMember.findOne({ where: { groupId: record.groupId, userId } }))) {
    throw new Error('不是群组成员');
  }
  if (await MessageDeletion.findOne({ where: { userId, kind: ref.kind, messageId: ref.id } }))
    throw new Error('消息已删除');
  return record;
}
export async function attachQuote(
  content: string,
  userId: number,
  ref: MessageReference,
  kind: MessageReference['kind'],
  targetId: number,
) {
  const record = await accessibleMessage(userId, ref);
  const sameConversation =
    record instanceof Message
      ? kind === 'private' &&
        ((record.fromUserId === userId && record.toUserId === targetId) ||
          (record.toUserId === userId && record.fromUserId === targetId))
      : kind === 'group' && record.groupId === targetId;
  if (!sameConversation) throw new Error('引用消息不属于当前会话');
  const senderId = record instanceof Message ? record.fromUserId : record.userId;
  const sender = await User.findByPk(senderId);
  return encodeReply(content, {
    id: ref.id,
    kind: ref.kind,
    senderName: sender?.nickname || sender?.username || '已注销用户',
    message: serializeChatMessage(record).message,
  });
}
export async function deleteMessages(
  userId: number,
  kind: MessageReference['kind'],
  ids: number[],
) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 100)
    throw new Error('请选择 1–100 条消息');
  const uniqueIds = [...new Set(ids)];
  // 重试删除是幂等操作，但仍需验证每条消息的归属。
  for (const id of uniqueIds) {
    if (!Number.isSafeInteger(id) || id < 1 || !['private', 'group'].includes(kind))
      throw new Error('消息标识无效');
    const alreadyDeleted = await MessageDeletion.findOne({
      where: { userId, kind, messageId: id },
    });
    if (!alreadyDeleted) await accessibleMessage(userId, { kind, id });
  }
  await MessageDeletion.bulkCreate(
    uniqueIds.map((messageId) => ({ userId, kind, messageId })),
    { ignoreDuplicates: true },
  );
  return uniqueIds;
}

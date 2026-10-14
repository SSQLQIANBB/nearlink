import crypto from 'crypto';
import { UniqueConstraintError } from 'sequelize';
import sequelize from '../config/database';
import { GroupMessage, Message, MessageReceipt } from '../models';

type Kind = 'private' | 'group';

export async function saveReliableMessage(input: {
  kind: Kind;
  userId: number;
  targetId: number;
  message: string;
  clientMessageId?: string;
}) {
  const { kind, userId, targetId, message, clientMessageId } = input;
  const contentHash = crypto
    .createHash('sha256')
    .update(JSON.stringify([targetId, message]))
    .digest('hex');
  if (clientMessageId && !/^[a-zA-Z0-9_-]{8,64}$/.test(clientMessageId))
    throw new Error('无效的消息标识');
  if (!clientMessageId) {
    const saved =
      kind === 'private'
        ? await Message.create({ fromUserId: userId, toUserId: targetId, message, isRead: false })
        : await GroupMessage.create({ groupId: targetId, userId, message });
    return { saved, duplicate: false };
  }

  try {
    const saved = await sequelize.transaction(async (transaction) => {
      await MessageReceipt.create(
        { userId, kind, clientMessageId, contentHash, messageId: null },
        { transaction },
      );
      const record =
        kind === 'private'
          ? await Message.create(
              { fromUserId: userId, toUserId: targetId, message, isRead: false },
              { transaction },
            )
          : await GroupMessage.create({ groupId: targetId, userId, message }, { transaction });
      await MessageReceipt.update(
        { messageId: record.id },
        { where: { userId, kind, clientMessageId }, transaction },
      );
      return record;
    });
    return { saved, duplicate: false };
  } catch (error) {
    if (!(error instanceof UniqueConstraintError)) throw error;
    const receipt = await MessageReceipt.findOne({ where: { userId, kind, clientMessageId } });
    if (!receipt || receipt.contentHash !== contentHash || !receipt.messageId)
      throw new Error('消息标识已用于其他内容');
    const saved =
      kind === 'private'
        ? await Message.findByPk(receipt.messageId)
        : await GroupMessage.findByPk(receipt.messageId);
    if (!saved) throw new Error('原消息不存在');
    return { saved, duplicate: true };
  }
}

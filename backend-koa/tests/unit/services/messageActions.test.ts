import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Op } from 'sequelize';
const mocks = vi.hoisted(() => ({
  privateRecords: new Map<number, any>(),
  groupRecords: new Map<number, any>(),
  deleted: new Set<string>(),
  member: vi.fn(),
  bulkCreate: vi.fn(),
}));
vi.mock('../../../src/models', () => ({
  Message: class Message {
    constructor(values: object) {
      Object.assign(this, values);
    }
    static findByPk(id: number) {
      return mocks.privateRecords.get(id);
    }
  },
  GroupMessage: { findByPk: (id: number) => mocks.groupRecords.get(id) },
  GroupMember: { findOne: mocks.member },
  User: { findByPk: async () => ({ nickname: '原发送人' }) },
}));
vi.mock('../../../src/models/MessageDeletion', () => ({
  default: {
    findOne: async ({ where }: any) =>
      mocks.deleted.has(`${where.userId}:${where.kind}:${where.messageId}`),
    bulkCreate: mocks.bulkCreate,
  },
}));
import { Message } from '../../../src/models';
import {
  accessibleMessage,
  attachQuote,
  deleteMessages,
  visibleMessages,
} from '../../../src/services/messageActions';
import { serializeChatMessage } from '../../../src/services/callHistoryService';
import { createChatMediaMessage } from '../../../src/services/chatMediaMessageService';
import { decodeReply } from '../../../src/services/messageQuote';

beforeEach(() => {
  mocks.privateRecords.clear();
  mocks.groupRecords.clear();
  mocks.deleted.clear();
  vi.clearAllMocks();
  mocks.privateRecords.set(
    1,
    new Message({ id: 1, fromUserId: 10, toUserId: 20, message: '原文', isRead: true }),
  );
  mocks.groupRecords.set(2, { id: 2, groupId: 7, userId: 10, message: '群聊原文' });
  mocks.member.mockResolvedValue({ canSpeak: true });
  mocks.bulkCreate.mockImplementation(async (rows: any[]) =>
    rows.forEach((row) => mocks.deleted.add(`${row.userId}:${row.kind}:${row.messageId}`)),
  );
});
describe('消息操作权限与持久化', () => {
  it('拒绝转发其他人的私信、非成员群聊和已删除消息', async () => {
    await expect(accessibleMessage(30, { kind: 'private', id: 1 })).rejects.toThrow(
      '无消息访问权限',
    );
    mocks.member.mockResolvedValue(null);
    await expect(accessibleMessage(30, { kind: 'group', id: 2 })).rejects.toThrow('不是群组成员');
    mocks.deleted.add('10:private:1');
    await expect(accessibleMessage(10, { kind: 'private', id: 1 })).rejects.toThrow('消息已删除');
  });
  it('删除只写入当前账号的隐藏记录，重复提交幂等，其他参与者仍能读取', async () => {
    await deleteMessages(10, 'private', [1, 1]);
    await deleteMessages(10, 'private', [1]);
    expect([...mocks.deleted]).toEqual(['10:private:1']);
    expect(await accessibleMessage(20, { kind: 'private', id: 1 })).toBe(
      mocks.privateRecords.get(1),
    );
    expect(visibleMessages(10, 'private')[Op.notIn].val).toContain(
      "userId = 10 AND kind = 'private'",
    );
  });
  it('批次包含无权访问的消息时不删除任何消息', async () => {
    mocks.privateRecords.set(
      3,
      new Message({ id: 3, fromUserId: 30, toUserId: 40, message: '私信', isRead: false }),
    );
    await expect(deleteMessages(10, 'private', [1, 3])).rejects.toThrow();
    expect(mocks.bulkCreate).not.toHaveBeenCalled();
    await expect(deleteMessages(10, 'private', [])).rejects.toThrow();
    await expect(deleteMessages(10, 'private', [NaN])).rejects.toThrow();
  });
  it('引用由服务端生成，限制在当前会话，并在原消息删除后保持摘要', async () => {
    const content = await attachQuote('回复', 20, { kind: 'private', id: 1 }, 'private', 10);
    await deleteMessages(20, 'private', [1]);
    expect(serializeChatMessage({ message: content })).toMatchObject({
      message: '回复',
      quote: { senderName: '原发送人', message: '原文', id: 1 },
    });
    await expect(attachQuote('回复', 10, { kind: 'group', id: 2 }, 'group', 8)).rejects.toThrow(
      '不属于当前会话',
    );
  });
  it('带引用的媒体在历史与实时消息中保留媒体结构，转发读取完整原文', async () => {
    const media = createChatMediaMessage({
      type: 'image',
      media: { url: 'https://example.com/a.png', mimeType: 'image/png' },
    });
    const content = await attachQuote(media, 10, { kind: 'group', id: 2 }, 'group', 7);
    expect(serializeChatMessage({ message: content })).toMatchObject({
      messageType: 'image',
      quote: { message: '群聊原文' },
      media: { mimeType: 'image/png' },
    });
    mocks.groupRecords.set(3, { id: 3, groupId: 7, userId: 10, message: content });
    expect((await accessibleMessage(20, { kind: 'group', id: 3 })).message).toBe(content);
    expect(decodeReply('__NEARLINK_REPLY__:{"content":1}')).toBeNull();
  });
});

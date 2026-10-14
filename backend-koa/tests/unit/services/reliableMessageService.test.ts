import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UniqueConstraintError } from 'sequelize';

const mocks = vi.hoisted(() => ({
  receipts: new Map<string, { contentHash: string; messageId: number }>(),
  broadcasts: vi.fn(),
  messages: [] as any[],
}));

vi.mock('../../../src/config/database', () => ({
  default: {
    transaction: async (run: (transaction: object) => Promise<unknown>) => run({}),
  },
}));
vi.mock('../../../src/models', () => ({
  MessageReceipt: {
    create: async (value: any) => {
      const key = `${value.userId}:${value.kind}:${value.clientMessageId}`;
      if (mocks.receipts.has(key)) throw new UniqueConstraintError({ errors: [] });
      mocks.receipts.set(key, { contentHash: value.contentHash, messageId: 0 });
    },
    update: async (value: any, options: any) => {
      const where = options.where;
      mocks.receipts.get(`${where.userId}:${where.kind}:${where.clientMessageId}`)!.messageId =
        value.messageId;
    },
    findOne: async ({ where }: any) =>
      mocks.receipts.get(`${where.userId}:${where.kind}:${where.clientMessageId}`),
  },
  Message: {
    create: async (value: any) => {
      const saved = { id: mocks.messages.length + 1, ...value };
      mocks.messages.push(saved);
      return saved;
    },
    findByPk: async (id: number) => mocks.messages.find((message) => message.id === id),
  },
  GroupMessage: { create: vi.fn(), findByPk: vi.fn() },
}));

import { saveReliableMessage } from '../../../src/services/reliableMessageService';

beforeEach(() => {
  mocks.receipts.clear();
  mocks.messages.length = 0;
});

describe('消息写入幂等', () => {
  it('同一发送人使用同一标识重试只写一条，并拒绝复用标识发送不同正文', async () => {
    const input = {
      kind: 'private' as const,
      userId: 1,
      targetId: 2,
      message: '你好',
      clientMessageId: 'message-id-123',
    };
    const first = await saveReliableMessage(input);
    const retried = await saveReliableMessage(input);
    expect(first.duplicate).toBe(false);
    expect(retried).toMatchObject({ duplicate: true, saved: { id: first.saved.id } });
    expect(mocks.messages).toHaveLength(1);
    await expect(saveReliableMessage({ ...input, message: '不同内容' })).rejects.toThrow(
      '消息标识已用于其他内容',
    );
  });
});

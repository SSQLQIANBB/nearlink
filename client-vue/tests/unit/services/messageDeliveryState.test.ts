import { describe, expect, it } from 'vitest';
import { applyMessageAck } from '@/services/messageDeliveryState';

describe('消息发送状态', () => {
  it('成功回执通过替换列表项更新为已发送', () => {
    const pending = {
      clientMessageId: 'client-1',
      message: '你好',
      sendStatus: 'pending' as const,
    };
    const messages = [pending];
    const updated = applyMessageAck(messages, 'client-1', {
      ok: true,
      id: 42,
      clientMessageId: 'client-1',
    });

    expect(updated).not.toBe(messages);
    expect(updated[0]).not.toBe(pending);
    expect(updated[0]).toMatchObject({ id: 42, sendStatus: 'sent' });
  });

  it('失败回执更新为失败且不影响其他消息', () => {
    const other = { clientMessageId: 'client-2', sendStatus: 'sent' as const };
    const updated = applyMessageAck(
      [{ clientMessageId: 'client-1', sendStatus: 'pending' as const }, other],
      'client-1',
      { ok: false, error: '发送失败' },
    );

    expect(updated[0]?.sendStatus).toBe('failed');
    expect(updated[1]).toBe(other);
  });
});

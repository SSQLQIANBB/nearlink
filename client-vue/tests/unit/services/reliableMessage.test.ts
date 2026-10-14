import { describe, expect, it, vi } from 'vitest';
import { sendReliableMessage } from '../../../src/services/reliableMessage';

describe('消息确认与重试', () => {
  it('超时后以相同消息标识重试并接受数据库确认', async () => {
    const emitWithAck = vi
      .fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ ok: true, id: 42 });
    const socket = { connected: true, timeout: () => ({ emitWithAck }) } as any;
    const data = { clientMessageId: 'same-message-id', message: '你好' };
    expect(await sendReliableMessage(socket, 'group_message', data)).toEqual({ ok: true, id: 42 });
    expect(emitWithAck).toHaveBeenCalledTimes(2);
    expect(emitWithAck.mock.calls[0]?.[1]).toBe(data);
    expect(emitWithAck.mock.calls[1]?.[1]).toBe(data);
  });

  it('连接断开时明确报告失败', async () => {
    expect(await sendReliableMessage(null, 'private_message', {})).toEqual({
      ok: false,
      error: '连接已断开，请稍后重试',
    });
  });
});

import type { Socket } from 'socket.io-client';

export type MessageAck =
  | { ok: true; id: number; clientMessageId: string }
  | { ok: false; error: string };

export async function sendReliableMessage(
  socket: Socket | null | undefined,
  event: 'private_message' | 'group_message',
  data: Record<string, unknown>,
): Promise<MessageAck> {
  if (!socket?.connected) return { ok: false, error: '连接已断开，请稍后重试' };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ack = (await socket.timeout(5000).emitWithAck(event, data)) as MessageAck;
      return ack?.ok ? ack : { ok: false, error: ack?.error || '发送失败' };
    } catch {
      if (!socket.connected) break;
    }
  }
  return { ok: false, error: '未收到服务器确认，请点击重试' };
}

import type { MessageAck } from './reliableMessage';

type DeliveryMessage = {
  id?: number;
  clientMessageId?: string;
  sendStatus?: 'pending' | 'sent' | 'failed';
};

export function applyMessageAck<T extends DeliveryMessage>(
  messages: readonly T[],
  clientMessageId: string,
  ack: MessageAck,
): T[] {
  let matched = false;
  const updated = messages.map((item) => {
    if (item.clientMessageId !== clientMessageId) return item;
    matched = true;
    return {
      ...item,
      ...(ack.ok ? { id: ack.id, sendStatus: 'sent' as const } : { sendStatus: 'failed' as const }),
    };
  });

  if (!matched || !ack.ok) return updated;
  // 返回工作区时历史可能已包含已发送消息；迟到的 ACK 只保留同一服务端 id 的一项。
  let confirmedSeen = false;
  return updated.filter(item => {
    if (item.id !== ack.id) return true;
    if (confirmedSeen) return false;
    confirmedSeen = true;
    return true;
  });
}

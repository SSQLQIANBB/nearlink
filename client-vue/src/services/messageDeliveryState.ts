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

  return matched ? updated : [...messages];
}

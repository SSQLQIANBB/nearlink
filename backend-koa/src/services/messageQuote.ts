export interface MessageQuote {
  id: number;
  kind: 'private' | 'group';
  senderName: string;
  message: string;
}
const PREFIX = '__NEARLINK_REPLY__:';
export function encodeReply(content: string, quote: MessageQuote) {
  return PREFIX + JSON.stringify({ content, quote });
}
export function decodeReply(message: string): { content: string; quote: MessageQuote } | null {
  if (!message.startsWith(PREFIX)) return null;
  try {
    const value = JSON.parse(message.slice(PREFIX.length));
    if (
      typeof value.content !== 'string' ||
      !value.quote ||
      !Number.isSafeInteger(value.quote.id) ||
      value.quote.id < 1 ||
      !['private', 'group'].includes(value.quote.kind) ||
      typeof value.quote.senderName !== 'string' ||
      typeof value.quote.message !== 'string'
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

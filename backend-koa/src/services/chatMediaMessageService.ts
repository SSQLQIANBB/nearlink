export type ChatMediaType = 'image' | 'voice';

export type ChatMediaPayload = {
  url: string;
  fileId?: number;
  mimeType: string;
  fileName?: string;
  fileSize?: number;
  durationSeconds?: number;
};

export type ChatMediaMessage = {
  type: ChatMediaType;
  media: ChatMediaPayload;
};

const CHAT_MEDIA_PREFIX = '__TODESK_CHAT_MEDIA__:';
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_VOICE_DURATION_SECONDS = 60;

function isAllowedUrl(url: string) {
  return url.startsWith('/uploads/') || url.startsWith('qiniu://') || /^https:\/\//i.test(url);
}

function parsePayload(value: unknown): ChatMediaMessage | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<ChatMediaMessage>;
  if (record.type !== 'image' && record.type !== 'voice') return null;
  if (!record.media || typeof record.media !== 'object') return null;

  const media = record.media;
  if (typeof media.url !== 'string' || !isAllowedUrl(media.url)) return null;
  if (media.fileId !== undefined && (!Number.isSafeInteger(media.fileId) || media.fileId < 1))
    return null;
  if (typeof media.mimeType !== 'string') return null;
  if (record.type === 'image' && !media.mimeType.startsWith('image/')) return null;
  if (record.type === 'voice' && !media.mimeType.startsWith('audio/')) return null;
  if (
    media.fileName !== undefined &&
    (typeof media.fileName !== 'string' || media.fileName.length > 255)
  )
    return null;
  if (
    media.fileSize !== undefined &&
    (!Number.isSafeInteger(media.fileSize) || media.fileSize <= 0 || media.fileSize > MAX_FILE_SIZE)
  )
    return null;
  if (
    record.type === 'voice' &&
    (!Number.isSafeInteger(media.durationSeconds) ||
      media.durationSeconds! < 1 ||
      media.durationSeconds! > MAX_VOICE_DURATION_SECONDS)
  )
    return null;

  return { type: record.type, media };
}

export function createChatMediaMessage(value: unknown) {
  const record = parsePayload(value);
  if (!record) throw new Error('媒体消息无效');
  return `${CHAT_MEDIA_PREFIX}${JSON.stringify(record)}`;
}

export function parseChatMediaMessage(message: string): ChatMediaMessage | null {
  if (!message.startsWith(CHAT_MEDIA_PREFIX)) return null;
  try {
    return parsePayload(JSON.parse(message.slice(CHAT_MEDIA_PREFIX.length)));
  } catch {
    return null;
  }
}

export function formatChatMediaMessage(record: ChatMediaMessage) {
  if (record.type === 'image') return `[图片] ${record.media.fileName || ''}`.trim();
  return `[语音] ${record.media.durationSeconds}秒`;
}

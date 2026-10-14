import { describe, expect, it } from 'vitest';
import {
  createChatMediaMessage,
  formatChatMediaMessage,
  parseChatMediaMessage,
} from '../../../src/services/chatMediaMessageService';

describe('聊天媒体消息', () => {
  it('序列化并恢复图片消息', () => {
    const message = createChatMediaMessage({
      type: 'image',
      media: {
        url: 'qiniu://private/chat/photo.png',
        fileId: 12,
        mimeType: 'image/png',
        fileName: 'photo.png',
        fileSize: 1024,
      },
    });
    const parsed = parseChatMediaMessage(message);
    expect(parsed).toMatchObject({
      type: 'image',
      media: { url: 'qiniu://private/chat/photo.png', fileId: 12 },
    });
    expect(formatChatMediaMessage(parsed!)).toBe('[图片] photo.png');
  });

  it('校验语音时长、类型和资源地址', () => {
    expect(() =>
      createChatMediaMessage({
        type: 'voice',
        media: { url: '/uploads/voice.webm', mimeType: 'audio/webm', durationSeconds: 61 },
      }),
    ).toThrow('媒体消息无效');
    expect(() =>
      createChatMediaMessage({
        type: 'image',
        media: { url: 'javascript:alert(1)', mimeType: 'image/png' },
      }),
    ).toThrow('媒体消息无效');
  });
});

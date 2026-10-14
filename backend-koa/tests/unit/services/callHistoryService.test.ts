import { describe, expect, it } from 'vitest';
import {
  createCallHistoryMessage,
  parseCallHistoryMessage,
  PrivateCallTracker,
  serializeChatMessage,
} from '../../../src/services/callHistoryService';
import { createChatMediaMessage } from '../../../src/services/chatMediaMessageService';

const request = {
  callerSocketId: 'caller-socket',
  calleeSocketId: 'callee-socket',
  callerUserId: 1,
  calleeUserId: 2,
  type: 'video' as const,
};

describe('通话历史', () => {
  it('从实际连接成功开始计算通话时长', () => {
    const tracker = new PrivateCallTracker();
    tracker.request(request);
    expect(tracker.respond('caller-socket', 'callee-socket', true)).toBeNull();
    tracker.connected('callee-socket', 'caller-socket', 10_000);

    expect(tracker.finish('caller-socket', 'callee-socket', 75_000)).toEqual({
      callerUserId: 1,
      calleeUserId: 2,
      type: 'video',
      status: 'completed',
      durationSeconds: 65,
    });
    expect(tracker.finish('caller-socket', 'callee-socket', 80_000)).toBeNull();
  });

  it('记录拒绝、取消和接听后未接通的结果', () => {
    const rejected = new PrivateCallTracker();
    rejected.request(request);
    expect(rejected.respond('caller-socket', 'callee-socket', false)?.status).toBe('rejected');

    const cancelled = new PrivateCallTracker();
    cancelled.request(request);
    expect(cancelled.finish('caller-socket', 'callee-socket')?.status).toBe('cancelled');

    const failed = new PrivateCallTracker();
    failed.request(request);
    failed.respond('caller-socket', 'callee-socket', true);
    expect(failed.finishForSocket('callee-socket')[0]?.status).toBe('failed');
  });

  it('支持记录语音通话', () => {
    const tracker = new PrivateCallTracker();
    tracker.request({ ...request, type: 'audio' });
    tracker.respond('caller-socket', 'callee-socket', true);
    tracker.connected('caller-socket', 'callee-socket', 1_000);
    expect(tracker.finish('caller-socket', 'callee-socket', 6_000)).toMatchObject({
      type: 'audio',
      status: 'completed',
      durationSeconds: 5,
    });
  });

  it('存储可读文本并在接口层恢复结构化通话消息', () => {
    const message = createCallHistoryMessage({
      type: 'screen',
      status: 'completed',
      durationSeconds: 3661,
    });
    expect(message).toBe(
      '__TODESK_CALL_HISTORY__:{"type":"screen","status":"completed","durationSeconds":3661}',
    );
    expect(parseCallHistoryMessage(message)).toEqual({
      type: 'screen',
      status: 'completed',
      durationSeconds: 3661,
    });
    expect(serializeChatMessage({ id: 3, message })).toEqual({
      id: 3,
      message: '[屏幕共享] 共享时长 01:01:01',
      messageType: 'call',
      call: {
        type: 'screen',
        status: 'completed',
        durationSeconds: 3661,
      },
    });
    expect(parseCallHistoryMessage('[屏幕共享] 共享时长 01:01:01')).toBeNull();
  });

  it('返回消息时把七牛稳定引用转换为可访问地址', () => {
    const message = createChatMediaMessage({
      type: 'image',
      media: {
        url: 'qiniu://public/avatar/photo.png',
        fileId: 3,
        mimeType: 'image/png',
      },
    });

    expect(serializeChatMessage({ id: 4, message })).toMatchObject({
      messageType: 'image',
      media: {
        url: 'https://files.example.test/avatar/photo.png',
        fileId: 3,
      },
    });
  });
});

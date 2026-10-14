import { describe, expect, it } from 'vitest';
import { formatCallDuration, getCallHistoryPresentation } from '@/services/callHistory';

describe('通话历史展示', () => {
  it('按微信式时分秒格式展示视频和共享时长', () => {
    expect(formatCallDuration(65)).toBe('01:05');
    expect(formatCallDuration(3661)).toBe('01:01:01');
    expect(
      getCallHistoryPresentation(
        {
          type: 'screen',
          status: 'completed',
          durationSeconds: 65,
        },
        true,
      ),
    ).toEqual({ title: '屏幕共享', detail: '共享时长 01:05' });
  });

  it('根据主叫和被叫身份展示拒绝及取消结果', () => {
    const rejected = { type: 'video', status: 'rejected', durationSeconds: 0 } as const;
    const cancelled = { type: 'video', status: 'cancelled', durationSeconds: 0 } as const;
    expect(getCallHistoryPresentation(rejected, true).detail).toBe('对方已拒绝');
    expect(getCallHistoryPresentation(rejected, false).detail).toBe('已拒绝');
    expect(getCallHistoryPresentation(cancelled, true).detail).toBe('已取消');
    expect(getCallHistoryPresentation(cancelled, false).detail).toBe('对方已取消');
  });

  it('展示语音通话记录', () => {
    expect(
      getCallHistoryPresentation(
        {
          type: 'audio',
          status: 'completed',
          durationSeconds: 12,
        },
        true,
      ),
    ).toEqual({ title: '语音通话', detail: '通话时长 00:12' });
  });
});

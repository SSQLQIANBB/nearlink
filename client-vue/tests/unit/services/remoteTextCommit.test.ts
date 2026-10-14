import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteTextCommitQueue } from '@/services/remoteTextCommit';
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());
describe('中文提交等待新输入票据', () => {
  it('input-armed先到不发送，当前代次票据到达后仅发送一次', async () => {
    const queue = new RemoteTextCommitQueue(() => Date.now());
    const send = vi.fn().mockReturnValue(true);
    const pending = queue.submit('你好👋', () => true);
    await vi.advanceTimersByTimeAsync(100);
    expect(send).not.toHaveBeenCalled();
    queue.windowAvailable(send);
    expect(await pending).toBe(true);
    queue.windowAvailable(send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].payload.text).toBe('你好👋');
  });
  it('500ms过期后新票据不能重放旧提交', async () => {
    const queue = new RemoteTextCommitQueue(() => Date.now());
    const send = vi.fn();
    const pending = queue.submit('旧文字', () => true);
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toBe(false);
    queue.windowAvailable(send);
    expect(send).not.toHaveBeenCalled();
  });
  it('失焦/结束取消后不发送；实际enqueue失败不能报告成功', async () => {
    const queue = new RemoteTextCommitQueue(() => Date.now());
    const send = vi.fn().mockReturnValue(false);
    const pending = queue.submit('取消文字', () => true);
    queue.cancel();
    queue.windowAvailable(send);
    expect(await pending).toBe(false);
    expect(send).not.toHaveBeenCalled();
    const next = queue.submit('发送失败', () => true);
    queue.windowAvailable(send);
    expect(await next).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { AudioChunkQueue } from '@/services/meetingMinutes/audioChunkQueue';

const pcm = () => new ArrayBuffer(6400);
const chunk = (partial: Partial<{ sampleCount: number; energy: number; isSilent: boolean }> = {}) => ({
  pcm: pcm(),
  sampleCount: 3200,
  energy: 0.01,
  isSilent: false,
  ...partial,
});

describe('AudioChunkQueue（确认收缩 + 在途背压）', () => {
  it('按入队顺序分配递增 audioIndex', () => {
    const queue = new AudioChunkQueue(200);
    expect(queue.enqueue(chunk()).audioIndex).toBe(0);
    expect(queue.enqueue(chunk()).audioIndex).toBe(1);
  });

  it('sendHead 把队首移入在途区；pending 不再包含该分片', () => {
    const queue = new AudioChunkQueue(200);
    queue.enqueue(chunk());
    queue.enqueue(chunk());
    expect(queue.pendingCount).toBe(2);
    expect(queue.inFlightCount).toBe(0);
    expect(queue.sendHead(() => true)).toBe(true);
    expect(queue.pendingCount).toBe(1);
    expect(queue.inFlightCount).toBe(1);
    expect(queue.pending[0]?.audioIndex).toBe(1);
  });

  it('仅按服务端累计确认收缩队列，重复确认不丢新分片', () => {
    const queue = new AudioChunkQueue(200);
    queue.enqueue(chunk());
    queue.enqueue(chunk());
    queue.sendHead(() => true);
    queue.confirmThrough(0);
    expect(queue.inFlightCount).toBe(0);
    expect(queue.pendingCount).toBe(1);
    // 重复确认值不收缩更多
    queue.confirmThrough(0);
    expect(queue.pendingCount).toBe(1);
    queue.confirmThrough(1);
    expect(queue.pendingCount).toBe(0);
  });

  it('pendingMs 按分片时长估算，用于背压上限判断', () => {
    const queue = new AudioChunkQueue(200);
    expect(queue.pendingMs).toBe(0);
    queue.enqueue(chunk());
    queue.enqueue(chunk());
    expect(queue.pendingMs).toBe(400);
  });

  it('discard 清空未确认分片', () => {
    const queue = new AudioChunkQueue(200);
    queue.enqueue(chunk());
    queue.sendHead(() => true);
    queue.enqueue(chunk());
    expect(queue.discard()).toBe(2);
    expect(queue.pendingCount).toBe(0);
    expect(queue.inFlightCount).toBe(0);
  });
});

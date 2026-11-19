/** 麦克风 worklet 产出的原始音频分片（PCM16LE，16kHz 单声道，约 200ms）。 */
export interface RawAudioChunk {
  pcm: ArrayBuffer;
  sampleCount: number;
  /** PCM 样本能量（均方），仅用于波形展示。 */
  energy: number;
  /** 整片 PCM 全零（设备无信号）；静音暂停判定以此为准。 */
  isSilent: boolean;
}

/** 入队后带上序号的分片。 */
export interface QueuedAudioChunk extends RawAudioChunk {
  audioIndex: number;
}

/**
 * 音频分片发送队列（有界背压）。
 *
 * 语义边界：
 * - 仅删除服务端已确认（ACK 携带 lastAcceptedAudioIndex）的分片；
 * - 发送失败保留队首，不推断服务端已收到；
 * - 确认乱序时按最小确认序号收缩，避免丢队首。
 */
export class AudioChunkQueue {
  private readonly pendingFrames: QueuedAudioChunk[] = [];
  private nextIndex = 0;
  private readonly chunkMs: number;

  constructor(chunkMs: number) {
    this.chunkMs = chunkMs;
  }

  /** 尚未发送的分片数量。 */
  get pendingCount(): number {
    return this.pendingFrames.length;
  }

  /** 未发送分片的只读视图（用于测试断言与诊断）。 */
  get pending(): readonly QueuedAudioChunk[] {
    return this.pendingFrames;
  }

  /** 队首分片的下一个序号；从未入队时为 0。 */
  get nextAudioIndex(): number {
    return this.nextIndex;
  }

  /** 队首尚未确认的分片序号；队列为空时为 -1。 */
  get firstUnconfirmedIndex(): number {
    return this.pendingFrames[0]?.audioIndex ?? -1;
  }

  /** 待发送音频时长估算（毫秒）。 */
  get pendingMs(): number {
    return this.pendingFrames.length * this.chunkMs;
  }

  /** 入队一个分片，返回带序号的副本。 */
  enqueue(chunk: RawAudioChunk): QueuedAudioChunk {
    const payload: QueuedAudioChunk = { ...chunk, audioIndex: this.nextIndex };
    this.nextIndex += 1;
    this.pendingFrames.push(payload);
    return payload;
  }

  /**
   * 按服务端累计确认值收缩队列。
   */
  confirmThrough(lastAcceptedAudioIndex: number): void {
    while (this.pendingFrames[0] && this.pendingFrames[0].audioIndex <= lastAcceptedAudioIndex) {
      this.pendingFrames.shift();
    }
    while (this.inFlight[0] && this.inFlight[0].audioIndex <= lastAcceptedAudioIndex) {
      this.inFlight.shift();
    }
  }

  /**
   * 按顺序发送队首一个分片（调用方负责在途上限判断）。
   * @param send 返回 true 表示已交给传输层；false 时保留队首。
   */
  sendHead(send: (chunk: QueuedAudioChunk) => boolean): boolean {
    const head = this.pendingFrames[0];
    if (!head) return true;
    if (!send(head)) return false;
    this.pendingFrames.shift();
    this.reappend(head);
    return true;
  }

  /** 已交给传输层但尚未确认的分片移入在途区（保持顺序、保留内存）。 */
  private readonly inFlight: QueuedAudioChunk[] = [];
  private reappend(chunk: QueuedAudioChunk): void {
    this.inFlight.push(chunk);
  }

  /** 在途分片数量（已发送、未确认）。 */
  get inFlightCount(): number {
    return this.inFlight.length;
  }

  retryUnconfirmed(): void {
    this.pendingFrames.unshift(...this.inFlight.splice(0));
  }

  restore(chunks: QueuedAudioChunk[], nextIndex: number): void {
    this.discard();
    this.pendingFrames.push(...chunks);
    this.nextIndex = nextIndex;
  }

  /** 显式丢弃未确认分片（仅用于本地放弃）。 */
  discard(): number {
    const count = this.pendingFrames.length + this.inFlight.length;
    this.pendingFrames.length = 0;
    this.inFlight.length = 0;
    return count;
  }
}

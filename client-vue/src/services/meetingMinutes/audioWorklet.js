/**
 * 会议录音 AudioWorklet 处理器（独立 JS，直接作为 worklet 模块执行）。
 *
 * 职责：重采样（输入采样率 → 16kHz）、低通滤波、PCM16LE 编码、
 * 按 timeslice 分帧、暂停尾片确认。纯 DSP，不含业务逻辑。
 *
 * 主线程消息协议：
 * - 主线程 → worklet: { type: 'pause' | 'resume' }
 * - worklet → 主线程: { type: 'chunk', buffer, sampleRate, sampleCount, energy, isAllZero, isLast }
 *                  | { type: 'paused' }  // 尾片已全部发出后的确认
 *
 * 在 PCM 量化前判断是否全零，避免把很小但有效的麦克风输入判成设备无信号。
 */

/** 一阶低通（两级级联），降低降采样混叠。 */
class LowPassFilter {
  constructor(inputSampleRate, outputSampleRate) {
    const cutoffFrequency = Math.min(outputSampleRate * 0.45, inputSampleRate * 0.45);
    this.alpha = 1 - Math.exp((-2 * Math.PI * cutoffFrequency) / inputSampleRate);
    this.stage1 = 0;
    this.stage2 = 0;
  }

  reset() {
    this.stage1 = 0;
    this.stage2 = 0;
  }

  process(samples) {
    const result = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      this.stage1 += this.alpha * (samples[i] - this.stage1);
      this.stage2 += this.alpha * (this.stage1 - this.stage2);
      result[i] = this.stage2;
    }
    return result;
  }
}

/** 流式线性插值重采样器（整数累计位置，避免长期浮点误差）。 */
class StreamingResampler {
  constructor(inputSampleRate, outputSampleRate) {
    this.inputSampleRate = inputSampleRate;
    this.outputSampleRate = outputSampleRate;
    this.lowPassFilter = new LowPassFilter(inputSampleRate, outputSampleRate);
    this.bufferStartIndex = 0;
    this.totalInputSamples = 0;
    this.nextOutputIndex = 0;
    this.pendingInput = new Float32Array(0);
  }

  reset() {
    this.bufferStartIndex = 0;
    this.totalInputSamples = 0;
    this.nextOutputIndex = 0;
    this.pendingInput = new Float32Array(0);
    this.lowPassFilter.reset();
  }

  process(samples) {
    if (!samples.length) return new Float32Array(0);
    if (this.inputSampleRate === this.outputSampleRate) {
      this.appendInput(new Float32Array(samples));
      return this.consumeOutput(false);
    }
    const filtered =
      this.inputSampleRate > this.outputSampleRate
        ? this.lowPassFilter.process(samples)
        : new Float32Array(samples);
    this.appendInput(filtered);
    return this.consumeOutput(false);
  }

  flush() {
    if (this.inputSampleRate === this.outputSampleRate) return new Float32Array(0);
    return this.consumeOutput(true);
  }

  appendInput(samples) {
    const combined = new Float32Array(this.pendingInput.length + samples.length);
    combined.set(this.pendingInput);
    combined.set(samples, this.pendingInput.length);
    this.pendingInput = combined;
    this.totalInputSamples += samples.length;
  }

  consumeOutput(flush) {
    const output = [];
    for (;;) {
      const sourceNumerator = this.nextOutputIndex * this.inputSampleRate;
      const beforeIndex = Math.floor(sourceNumerator / this.outputSampleRate);
      if (beforeIndex >= this.totalInputSamples) break;
      let afterIndex = beforeIndex + 1;
      if (!flush && afterIndex >= this.totalInputSamples) break;
      afterIndex = Math.min(afterIndex, this.totalInputSamples - 1);
      const localBefore = beforeIndex - this.bufferStartIndex;
      const localAfter = afterIndex - this.bufferStartIndex;
      const weight = (sourceNumerator % this.outputSampleRate) / this.outputSampleRate;
      const value =
        this.pendingInput[localBefore] +
        (this.pendingInput[localAfter] - this.pendingInput[localBefore]) * weight;
      output.push(value);
      this.nextOutputIndex += 1;
    }
    this.dropConsumedInput();
    return new Float32Array(output);
  }

  dropConsumedInput() {
    const nextSourceIndex = Math.floor((this.nextOutputIndex * this.inputSampleRate) / this.outputSampleRate);
    const dropUntil = Math.min(nextSourceIndex, this.totalInputSamples);
    const dropCount = Math.max(0, dropUntil - this.bufferStartIndex);
    if (dropCount <= 0) return;
    this.pendingInput = this.pendingInput.slice(dropCount);
    this.bufferStartIndex += dropCount;
  }
}

/**
 * 编码 PCM16LE。
 * 浏览器按主机字节序写 Int16；仅在宿主为大端时交换字节。
 */
function encodePcm16LE(samples, length) {
  const buffer = new ArrayBuffer(length * 2);
  const view = new DataView(buffer);
  const littleEndian = new Uint8Array(new Float32Array([0.5]).buffer)[0] === 0;
  for (let i = 0; i < length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    const pcm = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
    view.setInt16(i * 2, pcm, littleEndian);
  }
  if (!littleEndian) {
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const tmp = bytes[i];
      bytes[i] = bytes[i + 1];
      bytes[i + 1] = tmp;
    }
  }
  return buffer;
}

class RecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions = (options && options.processorOptions) || {};
    if (!processorOptions.inputSampleRate) throw new Error('inputSampleRate is required');
    this.inputSampleRate = processorOptions.inputSampleRate;
    this.outputSampleRate = processorOptions.outputSampleRate || 16000;
    const timeslice = processorOptions.timeslice || 200;
    this.chunkSize = Math.max(1, Math.round((this.outputSampleRate * timeslice) / 1000));
    this.resampler = new StreamingResampler(this.inputSampleRate, this.outputSampleRate);
    this.chunkBuffer = new Float32Array(this.chunkSize);
    this.chunkOffset = 0;
    this.paused = Boolean(processorOptions.paused);

    this.port.onmessage = (event) => {
      const type = event.data && event.data.type;
      if (type === 'pause') this.pauseAndFlush();
      else if (type === 'resume') this.paused = false;
    };
  }

  appendSamples(samples) {
    let sourceOffset = 0;
    while (sourceOffset < samples.length) {
      const writable = Math.min(this.chunkSize - this.chunkOffset, samples.length - sourceOffset);
      this.chunkBuffer.set(samples.subarray(sourceOffset, sourceOffset + writable), this.chunkOffset);
      sourceOffset += writable;
      this.chunkOffset += writable;
      if (this.chunkOffset === this.chunkSize) {
        this.emitChunk(this.chunkSize, false);
        this.chunkOffset = 0;
      }
    }
  }

  emitChunk(length, isLast) {
    if (!length) return;
    const pcmBuffer = encodePcm16LE(this.chunkBuffer, length);
    const samples = this.chunkBuffer.subarray(0, length);
    let energy = 0;
    for (let i = 0; i < samples.length; i++) energy += samples[i] * samples[i];
    const energyPerSample = energy / samples.length;
    this.port.postMessage(
      {
        type: 'chunk',
        buffer: pcmBuffer,
        sampleRate: this.outputSampleRate,
        sampleCount: length,
        energy: energyPerSample,
        isAllZero: energy === 0,
        isLast,
      },
      [pcmBuffer],
    );
  }

  /** 暂停前输出尾片；paused 确认必须晚于所有分片。 */
  pauseAndFlush() {
    if (this.paused) return;
    this.appendSamples(this.resampler.flush());
    this.emitChunk(this.chunkOffset, false);
    this.chunkOffset = 0;
    this.resampler.reset();
    this.paused = true;
    this.port.postMessage({ type: 'paused' });
  }

  process(inputs) {
    if (this.paused) return true;
    const channelData = inputs[0] && inputs[0][0];
    if (!channelData || !channelData.length) return true;
    const samples = this.resampler.process(channelData);
    if (samples.length) this.appendSamples(samples);
    return true;
  }
}

registerProcessor('nearlink-meeting-recorder', RecorderProcessor);

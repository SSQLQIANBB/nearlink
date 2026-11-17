import { LIMITS } from './constants';
import { RecordingError, normalizeRecordingError } from './recordingError';
import type { MinutesAudioInput } from './recordingManager';
import workletUrl from './audioWorklet.js?url';

interface InputResources {
  stream?: MediaStream;
  context?: AudioContext;
  source?: MediaStreamAudioSourceNode;
  analyser?: AnalyserNode;
  processor?: AudioWorkletNode;
  values?: Uint8Array<ArrayBuffer>;
  disposal?: Promise<void>;
}

/**
 * 浏览器麦克风采集：getUserMedia + AudioContext + AudioWorklet。
 *
 * 职责边界：只管输入与资源生命周期；网络重连、业务状态由 Manager 决定。
 * worklet 负责重采样到 16kHz、PCM16LE 编码、200ms 分帧与尾片确认。
 * worklet 是独立 JS 文件，经 `?url` 资源导入（Web 与桌面端 Tauri 构建一致）。
 */
export class BrowserAudioRecorder implements MinutesAudioInput {
  private readonly onChunk: (chunk: {
    pcm: ArrayBuffer;
    sampleCount: number;
    energy: number;
    isSilent: boolean;
  }) => void;
  private readonly onVolume: (data: { volume: number; waveList: number[] }) => void;
  private readonly onFault: (error: RecordingError) => void;
  private readonly workletMs: number;

  private input: InputResources | null = null;
  private generation = 0;
  private preparing: Promise<void> | null = null;
  private preparingInput: InputResources | null = null;
  private paused = true;
  private invalid = false;
  private pauseFailure: RecordingError | null = null;
  private frame: number | null = null;
  private permission: PermissionStatus | null = null;
  private pauseWaiter: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  private readonly handleDeviceChange = () => {
    if (this.input) this.reportFault(new RecordingError('MIC_DEVICE_LOST'));
  };

  constructor(options: {
    onChunk: (chunk: {
      pcm: ArrayBuffer;
      sampleCount: number;
      energy: number;
      isSilent: boolean;
    }) => void;
    onVolume: (data: { volume: number; waveList: number[] }) => void;
    onFault: (error: RecordingError) => void;
    workletMs?: number;
    workletUrl?: string;
  }) {
    this.onChunk = options.onChunk;
    this.onVolume = options.onVolume;
    this.onFault = options.onFault;
    this.workletMs = options.workletMs ?? LIMITS.workletMs;
  }

  get isReady(): boolean {
    return Boolean(this.input) && !this.invalid;
  }

  get pauseError(): boolean {
    return this.pauseFailure !== null;
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.generation) throw new RecordingError('CANCELLED');
  }

  prepare(): Promise<void> {
    if (this.preparing) return this.preparing;
    if (this.isReady) return Promise.resolve();
    const generation = this.generation;
    const promise = this.prepareInput(generation).finally(() => {
      if (this.preparing === promise) this.preparing = null;
    });
    this.preparing = promise;
    return promise;
  }

  private async prepareInput(generation: number): Promise<void> {
    const input: InputResources = {};
    this.preparingInput = input;
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new RecordingError('MIC_NOT_SUPPORTED');
      }
      input.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: { ideal: 1 },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      this.assertGeneration(generation);
      const Context: typeof AudioContext | undefined =
        window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Context || typeof AudioWorkletNode === 'undefined') {
        throw new RecordingError('MIC_NOT_SUPPORTED');
      }
      input.context = new Context({ latencyHint: 'interactive' });
      if (!input.context.audioWorklet) throw new RecordingError('MIC_NOT_SUPPORTED');
      await input.context.audioWorklet.addModule(workletUrl);
      this.assertGeneration(generation);
      input.source = input.context.createMediaStreamSource(input.stream);
      input.analyser = input.context.createAnalyser();
      input.analyser.fftSize = 256;
      input.values = new Uint8Array(input.analyser.fftSize);
      input.processor = new AudioWorkletNode(input.context, 'nearlink-meeting-recorder', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions: {
          inputSampleRate: input.context.sampleRate,
          outputSampleRate: LIMITS.sampleRate,
          timeslice: LIMITS.timesliceMs,
          paused: true,
        },
      });
      input.processor.port.onmessage = (event: MessageEvent) => {
        if (this.input === input) this.handleMessage(event.data);
      };
      input.processor.onprocessorerror = () => {
        if (this.input === input) this.reportFault(new RecordingError('AUDIO_FAILED'));
      };
      input.source.connect(input.analyser);
      input.source.connect(input.processor);
      input.stream.getAudioTracks().forEach((track) => {
        track.onended = this.handleDeviceChange;
      });
      this.input = input;
      this.invalid = false;
      this.pauseFailure = null;
      this.paused = true;
      navigator.mediaDevices.addEventListener?.('devicechange', this.handleDeviceChange);
      void this.watchPermission(generation);
      this.readVolume();
    } catch (error) {
      await this.releaseInput(input);
      throw normalizeRecordingError(error, 'AUDIO_FAILED');
    } finally {
      if (this.preparingInput === input) this.preparingInput = null;
    }
  }

  private async watchPermission(generation: number): Promise<void> {
    if (!navigator.permissions?.query) return;
    try {
      const permission = await navigator.permissions.query({ name: 'microphone' as PermissionName });
      if (generation !== this.generation || !this.input) return;
      this.permission = permission;
      permission.onchange = this.handleDeviceChange;
    } catch {
      // 不支持权限查询不影响 getUserMedia 的授权结果。
    }
  }

  private handleMessage(message: {
    type?: string;
    buffer?: ArrayBuffer;
    sampleCount?: number;
    energy?: number;
    isAllZero?: boolean;
  }): void {
    if (message?.type === 'paused') {
      this.settlePause();
      return;
    }
    if (message?.type !== 'chunk' || !(message.buffer instanceof ArrayBuffer)) return;
    this.onChunk({
      pcm: message.buffer,
      sampleCount: message.sampleCount ?? 0,
      energy: message.energy ?? 0,
      // 整片全零（设备无信号）才算静音；轻噪音/正常停顿不计入。
      isSilent:
        message.buffer.byteLength > 0 &&
        (message.isAllZero ?? new Uint8Array(message.buffer).every((byte) => byte === 0)),
    });
  }

  pause(): Promise<void> {
    if (this.pauseWaiter) return this.pauseWaiter.promise;
    if (this.pauseFailure) return Promise.reject(this.pauseFailure);
    if (!this.input || this.paused) return Promise.resolve();
    this.paused = true;
    let resolve: () => void;
    let reject: (e: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const timer = setTimeout(() => {
      this.invalid = true;
      this.settlePause(new RecordingError('AUDIO_TIMEOUT'));
    }, this.workletMs);
    this.pauseWaiter = { promise, resolve: () => resolve(), reject: (e) => reject(e), timer };
    try {
      this.input.processor!.port.postMessage({ type: 'pause' });
    } catch (error) {
      this.invalid = true;
      this.settlePause(normalizeRecordingError(error, 'AUDIO_FAILED'));
    }
    return promise;
  }

  private settlePause(error?: RecordingError): void {
    const waiter = this.pauseWaiter;
    if (!waiter) return;
    this.pauseWaiter = null;
    clearTimeout(waiter.timer);
    if (error) {
      if (error.type !== 'CANCELLED') this.pauseFailure = error;
      waiter.reject(error);
    } else {
      waiter.resolve();
    }
  }

  async resume(): Promise<void> {
    if (this.pauseWaiter) await this.pauseWaiter.promise;
    if (!this.isReady) throw new RecordingError('AUDIO_FAILED');
    const generation = this.generation;
    const input = this.input!;
    if (input.context!.state !== 'running') await input.context!.resume();
    this.assertGeneration(generation);
    input.processor!.port.postMessage({ type: 'resume' });
    this.paused = false;
  }

  async rebuild(): Promise<void> {
    const generation = this.generation + 1;
    await this.dispose();
    this.assertGeneration(generation);
    await this.prepare();
  }

  cancelPending(): void {
    this.generation += 1;
    this.preparing = null;
  }

  private reportFault(error: RecordingError): void {
    if (!this.input) return;
    this.invalid = true;
    this.onFault(error);
  }

  private readVolume(): void {
    const input = this.input;
    if (!input) return;
    input.analyser!.getByteTimeDomainData(input.values!);
    const energy = input.values!.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0);
    const volume = this.paused ? 0 : Math.min(Math.sqrt(energy / input.values!.length) * 5, 1);
    const time = Date.now() / 120;
    this.onVolume({
      volume,
      waveList: Array.from({ length: 58 }, (_, index) =>
        volume < 0.03
          ? 4
          : Math.round(4 + volume * (6 + Math.abs(Math.sin(index * 0.72 + time)) * 14)),
      ),
    });
    this.frame = requestAnimationFrame(() => this.readVolume());
  }

  private releaseInput(input: InputResources): Promise<void> {
    if (input.disposal) return input.disposal;
    if (!input.stream && !input.context) return Promise.resolve();
    input.disposal = this.closeInput(input);
    return input.disposal;
  }

  private async closeInput(input: InputResources): Promise<void> {
    if (input.processor) {
      input.processor.port.onmessage = null;
      input.processor.onprocessorerror = null;
      input.processor.disconnect();
    }
    input.source?.disconnect();
    input.analyser?.disconnect();
    input.stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    if (input.context && input.context.state !== 'closed') await input.context.close();
  }

  async dispose(): Promise<Error | null> {
    this.generation += 1;
    this.preparing = null;
    this.paused = true;
    this.settlePause(new RecordingError('CANCELLED'));
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    navigator.mediaDevices?.removeEventListener?.('devicechange', this.handleDeviceChange);
    if (this.permission) this.permission.onchange = null;
    this.permission = null;
    const input = this.input;
    const preparingInput = this.preparingInput;
    this.input = null;
    this.preparingInput = null;
    try {
      await Promise.all(
        [input, preparingInput].filter(Boolean).map((value) => this.releaseInput(value!)),
      );
      return null;
    } catch (error) {
      return error instanceof Error ? error : new RecordingError('CLEANUP_FAILED', error);
    }
  }
}

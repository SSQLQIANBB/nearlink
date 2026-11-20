import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import type { AsrClient, AsrSessionHandle, AsrTranscriptSegment } from './asrClient';

export const FINAL_TRANSCRIPT_PENDING = 'final_transcript_pending';
export const REGENERATE_TRANSCRIPT_PENDING = 'regenerate_transcript_pending';
export const FINAL_SUMMARY_PENDING = 'final_summary_pending';
export const FINAL_TRANSCRIPT_FAILED = 'final_transcript_failed';

const PCM_FRAME_BYTES = 6400;
const WAV_HEADER_BYTES = 44;

/** 只接受本项目生成的 16kHz 单声道 PCM16 WAV。分块边界与 HTTP 无关。 */
async function* wavFrames(source: AsyncIterable<Uint8Array>) {
  let pending: Buffer = Buffer.alloc(0);
  let remaining: number | null = null;
  for await (const chunk of source) {
    pending = Buffer.concat([pending, chunk]);
    if (remaining === null) {
      if (pending.length < WAV_HEADER_BYTES) continue;
      remaining = pending.readUInt32LE(40);
      if (pending.toString('ascii', 0, 4) !== 'RIFF' || pending.toString('ascii', 8, 12) !== 'WAVE' ||
          pending.toString('ascii', 36, 40) !== 'data' || pending.readUInt16LE(20) !== 1 ||
          pending.readUInt16LE(22) !== 1 || pending.readUInt32LE(24) !== 16_000 ||
          pending.readUInt16LE(34) !== 16 || remaining <= 0 || remaining % 2 !== 0) throw new Error('invalid_meeting_wav');
      pending = pending.subarray(WAV_HEADER_BYTES);
    }
    if (pending.length > remaining) throw new Error('invalid_meeting_wav_size');
    while (remaining > 0 && pending.length >= Math.min(remaining, PCM_FRAME_BYTES)) {
      const length = Math.min(remaining, PCM_FRAME_BYTES);
      yield pending.subarray(0, length);
      pending = pending.subarray(length);
      remaining -= length;
    }
  }
  if (remaining !== 0) throw new Error('truncated_meeting_wav');
}

type RecordingAsr = Pick<AsrClient, 'backend' | 'open'>;

export function transcribeMeetingWav(asr: RecordingAsr, filename: string, signal: AbortSignal) {
  return replayMeetingWav(asr, () => createReadStream(filename, { highWaterMark: PCM_FRAME_BYTES, signal }), signal);
}

export async function transcribeStoredMeetingWav(asr: RecordingAsr, signedUrl: string, signal: AbortSignal) {
  const controller = new AbortController();
  const downloadSignal = AbortSignal.any([signal, controller.signal]);
  return replayMeetingWav(asr, async () => {
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(signedUrl, { signal: downloadSignal, redirect: 'error' });
      if (!response.ok || !response.body) throw new Error('audio_download_failed');
      return Readable.fromWeb(response.body);
    } finally {
      clearTimeout(timer);
    }
  }, downloadSignal).finally(() => controller.abort());
}

async function replayMeetingWav(
  asr: RecordingAsr,
  source: () => AsyncIterable<Uint8Array> | Promise<AsyncIterable<Uint8Array>>,
  signal: AbortSignal,
) {
  const segments = new Map<number, Omit<AsrTranscriptSegment, 'isFinal'>>();
  let fault: Error | undefined;
  let stream: AsrSessionHandle | undefined;
  const listener: Parameters<AsrClient['open']>[0] = {
    onSegment: ({ isFinal, ...segment }) => {
      if (isFinal && segment.text.trim()) segments.set(segment.segmentId, segment);
    },
    onFault: error => { fault = error; },
  };
  const close = () => stream?.close();
  signal.addEventListener('abort', close, { once: true });
  try {
    signal.throwIfAborted();
    for await (const frame of wavFrames(await source())) {
      stream ??= await asr.open(listener);
      signal.throwIfAborted();
      if (fault) throw fault;
      const sentAt = performance.now();
      await stream.sendPcm(frame);
      if (asr.backend === 'sherpa') {
        const wait = frame.length / 32 - (performance.now() - sentAt);
        if (wait > 0) await delay(wait, undefined, { signal });
      }
    }
    if (!stream) throw new Error('audio_unavailable');
    await stream.finish();
    signal.throwIfAborted();
    if (fault) throw fault;
    return [...segments.values()].sort((a, b) => a.startMs - b.startMs || a.segmentId - b.segmentId);
  } finally {
    signal.removeEventListener('abort', close);
    close();
  }
}

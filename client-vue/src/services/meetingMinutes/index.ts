/**
 * 会议录音（会议纪要）服务入口。
 *
 * 分层：
 * - RecordingManager：录音生命周期、队列、恢复、结束和资源销毁（唯一状态来源）
 * - BrowserAudioRecorder / audioWorklet.js：浏览器采集与 DSP
 * - MeetingMinutesSocket：建连认证（握手）、二进制传输、请求响应、连接关闭
 * - AudioChunkQueue / transcript / constants / recordingError：纯逻辑
 *
 * 协议见 docs/MEETING_RECORDING_PROTOCOL.md；
 * `/meeting-minutes` 是 Socket.IO 的 path，不是 namespace。
 * 桌面端 Rust 采集（P3）将替换 MinutesAudioInput 的实现，Manager 不变。
 */
export { RecordingManager } from './recordingManager';
export type {
  MinutesAudioInput,
  RecordingManagerListeners,
  RecordingSnapshot,
} from './recordingManager';
export { BrowserAudioRecorder } from './audioRecorder';
export { MeetingMinutesSocket } from './socketClient';
export type {
  MeetingMinutesSocketOptions,
  MinutesAck,
  MinutesTranscriptMessage,
  MinutesErrorMessage,
} from './socketClient';
export { AudioChunkQueue } from './audioChunkQueue';
export type { QueuedAudioChunk, RawAudioChunk } from './audioChunkQueue';
export {
  appendTranscriptSegment,
  transcriptToPlainText,
  type TranscriptEntry,
  type TranscriptSegment,
} from './transcript';
export { RecordingError, normalizeRecordingError } from './recordingError';
export type { RecordingErrorType } from './recordingError';
export {
  PHASE,
  LIMITS,
  isActivePhase,
  type Phase,
} from './constants';

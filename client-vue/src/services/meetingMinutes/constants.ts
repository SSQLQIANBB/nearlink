/**
 * 会议录音状态机常量。
 *
 * 状态来源：录音业务只以 phase 为准；UI 直接消费 Manager 快照。
 */
export const PHASE = Object.freeze({
  IDLE: 'idle',
  STARTING: 'starting',
  RECORDING: 'recording',
  PAUSED: 'paused',
  RECOVERING: 'recovering',
  STOPPING: 'stopping',
  END_UNCONFIRMED: 'end-unconfirmed',
  ENDED: 'ended',
} as const);

export type Phase = (typeof PHASE)[keyof typeof PHASE];

/**
 * 发送约束：
 * - inFlight 在途分片上限（等待服务端 ACK），达到即停止发送形成背压；
 * - pendingMs 待发送音频时长上限（约 30 秒），超过后自动暂停并提示；
 * - 200ms/片：在途 5 片 ≈ 1 秒，30 秒上限 ≈ 150 片（约 960KB 内存）。
 */
export const LIMITS = Object.freeze({
  /** 连接 / start / attach 等控制请求的超时（毫秒）。 */
  requestMs: 60_000,
  /** end 收尾（含 ASR 最终识别）的超时（毫秒）。 */
  endMs: 120_000,
  /** 音频处理器暂停/尾片确认超时（毫秒）。 */
  workletMs: 3_000,
  /** 单次录音时长上限（毫秒），按已确认样本累计。 */
  recordingMs: 12 * 60 * 60 * 1_000,
  /** 暂停（含断线恢复中）时长上限（毫秒）。 */
  pauseMs: 3 * 60 * 60 * 1_000,
  /** 在途（未确认）分片上限。 */
  inFlight: 5,
  /** 待发送音频时长上限（毫秒）。 */
  pendingMs: 30_000,
  /** 连续全零分片（设备无信号）阈值，达到后自动暂停；正常停顿与轻噪音不计入。 */
  silentChunks: 10,
  /** 重采样输出采样率。 */
  sampleRate: 16_000,
  /** 每个分片时长（毫秒）：16kHz 单声道 PCM16LE，200ms ≈ 6400 字节。 */
  timesliceMs: 200,
});

export function isActivePhase(phase: Phase): boolean {
  return phase !== PHASE.IDLE && phase !== PHASE.ENDED;
}

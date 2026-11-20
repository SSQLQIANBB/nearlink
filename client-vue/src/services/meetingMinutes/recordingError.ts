/**
 * 录音错误类型与中文文案。
 *
 * type 是稳定的错误码（用于分支判断），message/suggestion 是面向用户的文案。
 */
export type RecordingErrorType =
  | 'MIC_PERMISSION_DENIED'
  | 'MIC_NOT_FOUND'
  | 'MIC_BUSY'
  | 'MIC_DEVICE_LOST'
  | 'MIC_NOT_SUPPORTED'
  | 'AUDIO_FAILED'
  | 'AUDIO_TIMEOUT'
  | 'SOCKET_CONNECT_FAILED'
  | 'SOCKET_CLOSED'
  | 'SOCKET_READY_TIMEOUT'
  | 'SOCKET_REJECTED'
  | 'SOCKET_AUTH_EXPIRED'
  | 'SOCKET_AUTH_FAILED'
  | 'SEND_FAILED'
  | 'SEND_BLOCKED'
  | 'SILENT_INPUT'
  | 'END_REJECTED'
  | 'END_UNCONFIRMED'
  | 'CLEANUP_FAILED'
  | 'TRANSCRIPT_INCOMPLETE'
  | 'UNSENT_AUDIO'
  | 'AUDIO_SAVE_FAILED'
  | 'AUDIO_SAVE_PARTIAL'
  | 'INVALID_OPERATION'
  | 'CANCELLED'
  | 'DRAFT_FAILED'
  | 'UNKNOWN';

const MESSAGES: Record<RecordingErrorType, [message: string, suggestion: string]> = {
  MIC_PERMISSION_DENIED: ['无法访问麦克风', '请在浏览器设置中允许麦克风权限后重试'],
  MIC_NOT_FOUND: ['未检测到麦克风', '请连接麦克风设备后重试'],
  MIC_BUSY: ['麦克风不可用', '请检查输入设备及其他正在使用麦克风的应用'],
  MIC_DEVICE_LOST: ['麦克风已断开', '请检查输入设备后继续录音'],
  MIC_NOT_SUPPORTED: ['当前浏览器不支持录音', '请使用支持 AudioWorklet 的浏览器'],
  AUDIO_FAILED: ['音频处理异常，录制已暂停', '请检查麦克风后继续录音'],
  AUDIO_TIMEOUT: ['音频处理器响应超时', '请检查麦克风后重试，尚未确认尾部音频完整'],
  SOCKET_CONNECT_FAILED: ['实时记录服务连接失败', '请检查网络后重试'],
  SOCKET_CLOSED: ['实时记录连接已中断', '正在尝试恢复连接'],
  SOCKET_READY_TIMEOUT: ['实时记录服务响应超时', '请稍后重试'],
  SOCKET_REJECTED: ['实时记录服务拒绝了请求', '请稍后重试'],
  SOCKET_AUTH_EXPIRED: ['登录状态已过期', '正在重新登录，录音已暂停'],
  SOCKET_AUTH_FAILED: ['登录会话已失效', '请重新登录后再开始录音'],
  SEND_FAILED: ['音频发送失败，录制已暂停', '请勿刷新或关闭页面，以免丢失待发送音频'],
  SEND_BLOCKED: ['待发送音频过多，录制已暂停', '请等待网络恢复后继续录音'],
  SILENT_INPUT: ['麦克风持续没有输入信号，录制已暂停', '请检查麦克风连接及静音设置'],
  END_REJECTED: ['结束失败，请重试', '录音保持暂停，可以继续或再次结束'],
  END_UNCONFIRMED: ['尚未确认录音是否结束', '请再次点击结束重试确认，确认前不能继续录音'],
  CLEANUP_FAILED: ['录音已结束，但部分资源清理失败', '请检查麦克风占用状态'],
  TRANSCRIPT_INCOMPLETE: ['部分音频未完成转写', '录音保存不受影响，可在会议记录中查看已确认文字'],
  DRAFT_FAILED: ['本地录音缓存不可用', '请保持页面打开并结束保存，避免关闭页面丢失尚未上传的音频'],
  UNSENT_AUDIO: ['服务端会话已结束，仍有音频未发送', '本次结果可能不包含未发送部分'],
  AUDIO_SAVE_PARTIAL: ['录音未正常结束，部分音频可能缺失', '已按保存的内容保留，可在会议记录中查看'],
  AUDIO_SAVE_FAILED: ['录音文字已保存，但音频保存失败', '可在会议记录中查看文字，音频可稍后重试'],
  INVALID_OPERATION: ['当前不能执行该操作', '请等待当前操作完成'],
  CANCELLED: ['操作已取消', ''],
  UNKNOWN: ['录音异常', '请稍后重试'],
};

export class RecordingError extends Error {
  readonly type: RecordingErrorType;
  readonly suggestion: string;
  readonly cause?: unknown;
  readonly phase?: string;

  constructor(type: RecordingErrorType, cause?: unknown, phase = '') {
    const [message, suggestion] = MESSAGES[type] ?? MESSAGES.UNKNOWN;
    super(message);
    this.name = 'RecordingError';
    this.type = type;
    this.suggestion = suggestion;
    this.cause = cause;
    this.phase = phase;
  }
}

const DOM_NAME_TO_TYPE: Record<string, RecordingErrorType> = {
  NotAllowedError: 'MIC_PERMISSION_DENIED',
  SecurityError: 'MIC_PERMISSION_DENIED',
  NotFoundError: 'MIC_NOT_FOUND',
  DevicesNotFoundError: 'MIC_NOT_FOUND',
  NotReadableError: 'MIC_BUSY',
  TrackStartError: 'MIC_BUSY',
  OverconstrainedError: 'MIC_BUSY',
  AbortError: 'MIC_DEVICE_LOST',
};

/** 将任意异常归一化为 RecordingError；已是 RecordingError 时原样返回。 */
export function normalizeRecordingError(
  error: unknown,
  fallback: RecordingErrorType = 'UNKNOWN',
  phase = '',
): RecordingError {
  if (error instanceof RecordingError) return error;
  const cause = (error as { cause?: unknown } | null)?.cause ?? error;
  const name = (cause as { name?: string } | null)?.name;
  return new RecordingError(name ? DOM_NAME_TO_TYPE[name] ?? fallback : fallback, cause, phase);
}

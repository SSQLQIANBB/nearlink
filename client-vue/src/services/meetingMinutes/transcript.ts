/**
 * 转写片段合并的纯函数。
 *
 * 契约（与 docs/MEETING_RECORDING_PROTOCOL.md 对齐）：
 * - 服务端推送的每个片段是当前句的累计文本；
 * - 同一 segmentId 的临时结果替换当前临时句；
 * - 最终结果（isFinal）覆盖该句并落定，不重复追加；
 * - speakerId 仅表达说话人，不用于判断是否确认。
 */

/** 服务端推送的单个转写片段（当前句累计文本）。 */
export interface TranscriptSegment {
  segmentId: number;
  text: string;
  isFinal: boolean;
  startMs: number;
  endMs: number | null;
  /** 说话人标识；ASR 未分离时为 null，展示时归入发言人 1。 */
  speakerId: string | null;
}

/** 合并后的展示条目。 */
export interface TranscriptEntry {
  segmentId: number;
  content: string;
  /** 句子开始的录音秒数（取首次出现时的累计秒数，不随后续消息变化）。 */
  startSecond: number;
  /** 句子开始的毫秒偏移（服务端值，用于时间戳展示）。 */
  startMs: number;
  /** 说话人标识；null 表示 ASR 未分离。 */
  speakerId: string | null;
  /** 句子确认时的结束毫秒偏移；0 表示仍在临时中。 */
  endTime: number;
  isFinal: boolean;
}

/**
 * 将服务端片段合并进列表，返回新数组（不修改入参）。
 * 同一 segmentId 替换原条目；最终结果落定后不再变化。
 * speakerId 仅用于展示区分，不用于判断是否确认。
 */
export function appendTranscriptSegment(
  list: TranscriptEntry[],
  segment: TranscriptSegment,
  seconds: number,
): TranscriptEntry[] {
  const entry: TranscriptEntry = {
    segmentId: segment.segmentId,
    content: segment.text,
    startSecond: seconds,
    startMs: segment.startMs,
    speakerId: segment.speakerId,
    endTime: segment.isFinal ? (segment.endMs ?? 0) : 0,
    isFinal: segment.isFinal,
  };
  const index = list.findIndex((item) => item.segmentId === segment.segmentId);
  if (list[index]?.isFinal) return list;
  if (segment.isFinal && !segment.text.trim()) {
    return index === -1 ? list : list.filter((_, position) => position !== index);
  }
  if (index === -1) return [...list, entry];
  const next = list.slice();
  next[index] = {
    ...next[index],
    ...entry,
    startSecond: next[index]!.startSecond,
    // 说话人可能随 ASR 结果逐步明确，始终取最新值。
    startMs: entry.startMs,
  };
  return next;
}

/** 从合并结果导出纯文本转写（仅取已确认句），用于保存与 LLM 纪要输入。 */
export function transcriptToPlainText(entries: TranscriptEntry[]): string {
  return entries
    .filter((entry) => entry.isFinal)
    .map((entry) => entry.content)
    .filter(Boolean)
    .join('\n');
}

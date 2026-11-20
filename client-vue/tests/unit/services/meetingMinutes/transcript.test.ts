import { describe, expect, it } from 'vitest';
import {
  appendTranscriptSegment,
  transcriptToPlainText,
  type TranscriptEntry,
  type TranscriptSegment,
} from '@/services/meetingMinutes/transcript';

const segment = (partial: Partial<TranscriptSegment> = {}): TranscriptSegment => ({
  segmentId: 1,
  text: '你好',
  isFinal: false,
  startMs: 0,
  endMs: null,
  speakerId: null,
  ...partial,
});

describe('appendTranscriptSegment（累计文本替换语义）', () => {
  it('同一 segmentId 的临时结果替换当前临时文本', () => {
    let list: TranscriptEntry[] = [];
    list = appendTranscriptSegment(list, segment({ text: '你好' }), 0);
    list = appendTranscriptSegment(list, segment({ text: '你好世界' }), 0);
    expect(list).toHaveLength(1);
    expect(list[0]?.content).toBe('你好世界');
    expect(list[0]?.isFinal).toBe(false);
  });

  it('最终结果覆盖临时句并落定，不重复追加', () => {
    let list: TranscriptEntry[] = [];
    list = appendTranscriptSegment(list, segment({ text: '你好世界' }), 0);
    list = appendTranscriptSegment(
      list,
      segment({ text: '你好世界。', isFinal: true, endMs: 1500 }),
      1,
    );
    expect(list).toHaveLength(1);
    expect(list[0]?.content).toBe('你好世界。');
    expect(list[0]?.isFinal).toBe(true);
    expect(list[0]?.endTime).toBe(1500);
  });

  it('不同 segmentId 依次追加为独立条目', () => {
    let list: TranscriptEntry[] = [];
    list = appendTranscriptSegment(list, segment({ segmentId: 1, text: '第一句', isFinal: true, endMs: 1000 }), 0);
    list = appendTranscriptSegment(list, segment({ segmentId: 2, text: '第二句' }), 1);
    expect(list).toHaveLength(2);
    expect(list[1]?.segmentId).toBe(2);
  });

  it('落定后的最终句不再被同 segmentId 的迟到临时句覆盖', () => {
    let list: TranscriptEntry[] = [];
    list = appendTranscriptSegment(list, segment({ segmentId: 1, text: '最终', isFinal: true, endMs: 1000 }), 0);
    list = appendTranscriptSegment(list, segment({ segmentId: 1, text: '最终' }), 1);
    // 已确认的句子需要忽略迟到的同 id 临时结果。
    expect(list[0]?.content).toBe('最终');
    expect(list[0]?.isFinal).toBe(true);
  });
});

describe('transcriptToPlainText', () => {
  it('只导出已确认句', () => {
    let list: TranscriptEntry[] = [];
    list = appendTranscriptSegment(list, segment({ segmentId: 1, text: '确认句', isFinal: true, endMs: 1000 }), 0);
    list = appendTranscriptSegment(list, segment({ segmentId: 2, text: '临时句' }), 1);
    expect(transcriptToPlainText(list)).toBe('确认句');
  });
});

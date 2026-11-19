import { EventEmitter } from 'node:events';
import { col, fn, Op, type FindAttributeOptions } from 'sequelize';
import { MeetingMinutes } from '../models/MeetingMinutes';
import { FINAL_TRANSCRIPT_PENDING, REGENERATE_TRANSCRIPT_PENDING } from './meetingFinalTranscript';

export const meetingListAttributes: FindAttributeOptions = [
  'sessionId', 'title', 'source', 'status', 'summaryStatus', 'summaryError', 'durationSeconds', 'audioStatus', 'createdAt', 'endedAt',
  [fn('LENGTH', fn('TRIM', col('summary'))), 'summaryLength'],
  [fn('LENGTH', fn('TRIM', col('keyPoints'))), 'keyPointsLength'],
];

export function serializeMeetingListItem(record: MeetingMinutes) {
  const plain = record.get({ plain: true }) as Record<string, unknown>;
  const regeneratingTranscript = record.summaryStatus === 'generating' && record.summaryError === REGENERATE_TRANSCRIPT_PENDING;
  const generationStage: 'transcript' | 'summary' | null = record.status === 'finalizing' || regeneratingTranscript ||
    (record.summaryStatus === 'generating' && record.summaryError === FINAL_TRANSCRIPT_PENDING)
    ? 'transcript' : record.summaryStatus === 'generating' ? 'summary' : null;
  return {
    sessionId: plain.sessionId,
    title: plain.title,
    source: plain.source,
    status: plain.status,
    summaryStatus: plain.summaryStatus,
    summaryError: record.summaryError ?? null,
    generationStage,
    regeneratingTranscript,
    hasSummary: (typeof plain.summary === 'string' && !!plain.summary.trim()) ||
      (typeof plain.keyPoints === 'string' && plain.keyPoints.trim().length > 2) ||
      Number(plain.summaryLength) > 0 || Number(plain.keyPointsLength) > 2,
    durationSeconds: plain.durationSeconds,
    audioStatus: plain.audioStatus ?? 'missing',
    createdAt: plain.createdAt,
    endedAt: plain.endedAt,
  };
}

type MeetingChange = { userId: number; sessionId: string; kind: 'details' | 'metadata' | 'removed' };
const events = new EventEmitter();

export function publishMeetingChange(userId: number, sessionId: string, kind: MeetingChange['kind'] = 'details') {
  events.emit('change', { userId, sessionId, kind });
}

export function observeMeetingChanges(
  subscribers: (userId: number) => string[],
  emit: (socketIds: string[], payload: { sessionId: string; item: ReturnType<typeof serializeMeetingListItem> | null; detailChanged: boolean }) => void,
) {
  const pending = new Map<string, MeetingChange>();
  const reading = new Set<string>();
  let closed = false;

  async function flush(sessionId: string) {
    reading.add(sessionId);
    try {
      let change: MeetingChange | undefined;
      while (!closed && (change = pending.get(sessionId))) {
        pending.delete(sessionId);
        if (!subscribers(change.userId).length) continue;
        const record = change.kind === 'removed' ? null : await MeetingMinutes.findOne({
          where: { sessionId, userId: change.userId, audioStatus: { [Op.ne]: 'deleting' } },
          attributes: meetingListAttributes,
        });
        const socketIds = subscribers(change.userId);
        if (!closed && socketIds.length) emit(socketIds, {
          sessionId, item: record ? serializeMeetingListItem(record) : null, detailChanged: change.kind !== 'metadata',
        });
      }
    } catch (error) {
      console.error('meeting_push_failed', { sessionId, message: (error as Error).message });
    } finally {
      reading.delete(sessionId);
      if (!closed && pending.has(sessionId)) void flush(sessionId);
    }
  }

  function enqueue(change: MeetingChange) {
    const previous = pending.get(change.sessionId);
    if (change.kind === 'metadata' && previous?.kind === 'details') change = previous;
    pending.set(change.sessionId, change);
    if (!reading.has(change.sessionId)) void flush(change.sessionId);
  }

  events.on('change', enqueue);
  return () => { closed = true; pending.clear(); events.off('change', enqueue); };
}

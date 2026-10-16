import { formatChatMediaMessage, parseChatMediaMessage } from './chatMediaMessageService';
import { decodeReply } from './messageQuote';
import { qiniuStorage } from './qiniuStorageService';

export type CallHistoryType = 'video' | 'audio' | 'screen';
export type CallHistoryStatus = 'completed' | 'rejected' | 'cancelled' | 'failed';

export type CallHistoryRecord = {
  type: CallHistoryType;
  status: CallHistoryStatus;
  durationSeconds: number;
};

export type PrivateCallHistoryRecord = CallHistoryRecord & {
  callerUserId: number;
  calleeUserId: number;
};

type PrivateCallSession = {
  callId?: string;
  callerSocketId: string;
  calleeSocketId: string;
  callerUserId: number;
  calleeUserId: number;
  type: CallHistoryType;
  accepted: boolean;
  startedAt?: number;
};

const CALL_LABELS: Record<CallHistoryType, string> = {
  video: '视频通话',
  audio: '语音通话',
  screen: '屏幕共享',
};

const STATUS_LABELS: Record<Exclude<CallHistoryStatus, 'completed'>, string> = {
  rejected: '已拒绝',
  cancelled: '已取消',
  failed: '未接通',
};

const CALL_HISTORY_PREFIX = '__TODESK_CALL_HISTORY__:';

export function formatCallDuration(durationSeconds: number) {
  const seconds = Math.max(0, Math.floor(durationSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  const parts = [minutes, remainingSeconds].map((value) => String(value).padStart(2, '0'));

  if (hours > 0) parts.unshift(String(hours).padStart(2, '0'));
  return parts.join(':');
}

export function formatCallHistoryMessage(record: CallHistoryRecord) {
  const label = CALL_LABELS[record.type];
  if (record.status === 'completed') {
    const durationLabel = record.type === 'screen' ? '共享时长' : '通话时长';
    return `[${label}] ${durationLabel} ${formatCallDuration(record.durationSeconds)}`;
  }

  return `[${label}] ${STATUS_LABELS[record.status]}`;
}

export function createCallHistoryMessage(record: CallHistoryRecord) {
  return `${CALL_HISTORY_PREFIX}${JSON.stringify({
    type: record.type,
    status: record.status,
    durationSeconds: record.durationSeconds,
  })}`;
}

export function parseCallHistoryMessage(message: string): CallHistoryRecord | null {
  if (!message.startsWith(CALL_HISTORY_PREFIX)) return null;

  try {
    const record = JSON.parse(
      message.slice(CALL_HISTORY_PREFIX.length),
    ) as Partial<CallHistoryRecord>;
    if (!['video', 'audio', 'screen'].includes(record.type || '')) return null;
    if (!['completed', 'rejected', 'cancelled', 'failed'].includes(record.status || ''))
      return null;
    if (!Number.isSafeInteger(record.durationSeconds) || record.durationSeconds! < 0) return null;
    return record as CallHistoryRecord;
  } catch {
    return null;
  }
}

export function serializeChatMessage(record: any) {
  const message = typeof record?.toJSON === 'function' ? record.toJSON() : record;
  const reply = decodeReply(message.message);
  if (reply)
    return { ...serializeChatMessage({ ...message, message: reply.content }), quote: reply.quote };
  const call = parseCallHistoryMessage(message.message);
  if (call)
    return { ...message, message: formatCallHistoryMessage(call), messageType: 'call', call };

  const mediaMessage = parseChatMediaMessage(message.message);
  if (mediaMessage) {
    mediaMessage.media.url = qiniuStorage.resolveUrl(mediaMessage.media.url);
  }
  return mediaMessage
    ? {
        ...message,
        message: formatChatMediaMessage(mediaMessage),
        messageType: mediaMessage.type,
        media: mediaMessage.media,
      }
    : message;
}

export class PrivateCallTracker {
  private readonly sessions = new Map<string, PrivateCallSession>();

  isPending(callerSocketId: string, calleeSocketId: string, callId: string) {
    const session = this.sessions.get(this.getKey(callerSocketId, calleeSocketId));
    return !!session && !session.accepted && session.callId === callId;
  }

  getPeerSocketIds(socketId: string) {
    return [...this.sessions.values()].flatMap((session) => {
      if (session.callerSocketId === socketId) return [session.calleeSocketId];
      if (session.calleeSocketId === socketId) return [session.callerSocketId];
      return [];
    });
  }

  request(session: Omit<PrivateCallSession, 'accepted' | 'startedAt'>) {
    const existingKey = this.findKey(session.callerSocketId, session.calleeSocketId);
    if (existingKey) this.sessions.delete(existingKey);
    this.sessions.set(this.getKey(session.callerSocketId, session.calleeSocketId), {
      ...session,
      accepted: false,
    });
  }

  respond(callerSocketId: string, calleeSocketId: string, accepted: boolean, setupFailed = false) {
    const key = this.getKey(callerSocketId, calleeSocketId);
    const session = this.sessions.get(key);
    if (!session) return null;

    if (accepted) {
      session.accepted = true;
      return null;
    }

    this.sessions.delete(key);
    return this.toRecord(session, setupFailed ? 'failed' : 'rejected', 0);
  }

  connected(socketId: string, peerSocketId: string, connectedAt = Date.now()) {
    const key = this.findKey(socketId, peerSocketId);
    const session = key ? this.sessions.get(key) : undefined;
    if (!session?.accepted || session.startedAt) return;
    session.startedAt = connectedAt;
  }

  finish(socketId: string, peerSocketId: string, endedAt = Date.now()) {
    const key = this.findKey(socketId, peerSocketId);
    if (!key) return null;
    const session = this.sessions.get(key)!;
    this.sessions.delete(key);
    return this.finishSession(session, endedAt);
  }

  finishForSocket(socketId: string, endedAt = Date.now()) {
    const records: PrivateCallHistoryRecord[] = [];
    for (const [key, session] of this.sessions) {
      if (session.callerSocketId !== socketId && session.calleeSocketId !== socketId) continue;
      this.sessions.delete(key);
      records.push(this.finishSession(session, endedAt));
    }
    return records;
  }

  private getKey(callerSocketId: string, calleeSocketId: string) {
    return `${callerSocketId}:${calleeSocketId}`;
  }

  private findKey(leftSocketId: string, rightSocketId: string) {
    const direct = this.getKey(leftSocketId, rightSocketId);
    if (this.sessions.has(direct)) return direct;
    const reverse = this.getKey(rightSocketId, leftSocketId);
    return this.sessions.has(reverse) ? reverse : undefined;
  }

  private finishSession(session: PrivateCallSession, endedAt: number) {
    if (!session.startedAt) {
      return this.toRecord(session, session.accepted ? 'failed' : 'cancelled', 0);
    }

    const durationSeconds = Math.max(1, Math.round((endedAt - session.startedAt) / 1000));
    return this.toRecord(session, 'completed', durationSeconds);
  }

  private toRecord(
    session: PrivateCallSession,
    status: CallHistoryStatus,
    durationSeconds: number,
  ): PrivateCallHistoryRecord {
    return {
      callerUserId: session.callerUserId,
      calleeUserId: session.calleeUserId,
      type: session.type,
      status,
      durationSeconds,
    };
  }
}

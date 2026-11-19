import { http } from '@/utils/request';

export interface MeetingTranscriptWord {
  text: string;
  startMs: number;
  endMs: number;
}

/** 转写片段（与 transcriptJson 存储结构对齐）。 */
export interface MeetingTranscriptItem {
  segmentId: number;
  text: string;
  startMs: number;
  endMs: number | null;
  /** 说话人标识；ASR 未分离时为 null。 */
  speakerId: string | null;
  words?: MeetingTranscriptWord[];
}

export interface MeetingListItem {
  sessionId: string;
  title: string;
  source: 'offline' | 'call';
  /** 录音状态：recording/paused/finalizing/ended/failed。 */
  status: 'recording' | 'paused' | 'finalizing' | 'ended' | 'failed';
  /** 纪要状态：idle/generating/ready/failed（与录音状态独立）。 */
  summaryStatus: 'idle' | 'generating' | 'ready' | 'failed';
  summaryError: string | null;
  generationStage: 'transcript' | 'summary' | null;
  regeneratingTranscript: boolean;
  hasSummary: boolean;
  /** 音频状态（与录音状态独立）：ready/partial 可播放，failed/missing 无音频。 */
  audioStatus: 'recording' | 'pending' | 'uploading' | 'ready' | 'partial' | 'failed' | 'missing';
  durationSeconds: number;
  createdAt: string;
  endedAt?: string | null;
}

export interface MeetingDetail extends MeetingListItem {
  sourceLanguage: string;
  targetLanguage: string;
  /** 签名播放地址（私有空间）；签名过期后重新请求详情换新地址。 */
  audioUrl: string | null;
  audioDownloadUrl: string | null;
  audioError: string | null;
  audioSize: number | null;
  transcript: string;
  transcriptJson: MeetingTranscriptItem[];
  summary: string;
  keyPoints: string[];
  mindmap: string;
}

export interface MeetingListResult {
  items: MeetingListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface MeetingUpdate {
  sessionId: string;
  item: MeetingListItem | null;
  detailChanged: boolean;
}

/** 我的会议记录列表（数据库分页）。 */
export function getMeetings(page = 1, pageSize = 20, signal?: AbortSignal, sessionId?: string) {
  const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (sessionId) query.set('sessionId', sessionId);
  return http.get<MeetingListResult>(`/api/meetings?${query}`, signal);
}

/** 会议详情（含转写与纪要）。 */
export function getMeeting(sessionId: string, signal?: AbortSignal) {
  return http.get<{ meeting: MeetingDetail }>(`/api/meetings/${sessionId}`, signal);
}

/** 活动录音状态（刷新后查询服务端真实状态，用于提示继续/结束，不自动开麦）。 */
export interface ActiveMeetingState {
  active: boolean;
  source?: 'offline' | 'call';
  sessionId?: string;
  status?: 'recording' | 'paused' | 'finalizing';
  audioStatus?: string;
  durationSeconds?: number;
  /** 暂停草稿是否仍在保留期内（可继续）。 */
  resumable?: boolean;
}
export function getActiveMeeting(signal?: AbortSignal) {
  return http.get<ActiveMeetingState>('/api/meetings/active', signal);
}

export function discardMeeting(sessionId: string) {
  return http.post<{ ok: true }>(`/api/meetings/${sessionId}/discard`, undefined, AbortSignal.timeout(15_000));
}

/** 修改会议标题。 */
export function renameMeeting(sessionId: string, title: string, signal?: AbortSignal) {
  return http.put<{ ok: boolean }>(`/api/meetings/${sessionId}/title`, { title }, signal);
}

/** 生成/重新生成 AI 纪要。 */
export function generateMeetingSummary(sessionId: string, signal?: AbortSignal) {
  return http.post<{ meeting: MeetingDetail }>(`/api/meetings/${sessionId}/summary`, undefined, signal);
}

export function regenerateMeetingTranscript(sessionId: string, signal?: AbortSignal) {
  return http.post<{ ok: true }>(`/api/meetings/${sessionId}/transcript`, undefined, signal);
}

/** 删除会议记录。 */
export function deleteMeeting(sessionId: string, signal?: AbortSignal) {
  return http.delete<{ ok: boolean }>(`/api/meetings/${sessionId}`, signal);
}

export function deleteMeetings(sessionIds: string[], signal?: AbortSignal) {
  return http.post<{ deletedCount: number }>('/api/meetings/batch-delete', { sessionIds }, signal);
}

export function retryMeetingAudio(sessionId: string, signal?: AbortSignal) {
  return http.post<{ meeting: MeetingDetail }>('/api/meetings/' + sessionId + '/audio/retry', undefined, signal);
}

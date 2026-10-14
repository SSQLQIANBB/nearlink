import type { CallHistoryRecord } from '@/api/message';

export function formatCallDuration(durationSeconds: number) {
  const seconds = Math.max(0, Math.floor(durationSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  const parts = [minutes, remainingSeconds].map((value) => String(value).padStart(2, '0'));

  if (hours > 0) parts.unshift(String(hours).padStart(2, '0'));
  return parts.join(':');
}

export function getCallHistoryPresentation(record: CallHistoryRecord, isMine: boolean) {
  const title =
    record.type === 'screen' ? '屏幕共享' : record.type === 'audio' ? '语音通话' : '视频通话';
  if (record.status === 'completed') {
    return {
      title,
      detail: `${record.type === 'screen' ? '共享时长' : '通话时长'} ${formatCallDuration(record.durationSeconds)}`,
    };
  }

  const details = {
    rejected: isMine ? '对方已拒绝' : '已拒绝',
    cancelled: isMine ? '已取消' : '对方已取消',
    failed: '未接通',
  } as const;

  return { title, detail: details[record.status] };
}

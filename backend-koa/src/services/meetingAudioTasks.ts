import { Op } from 'sequelize';
import { MeetingMinutes } from '../models/MeetingMinutes';
import { meetingAudioStore } from './meetingAudioStore';
import { FINAL_TRANSCRIPT_FAILED } from './meetingFinalTranscript';
import { publishMeetingChange } from './meetingChanges';

const running = new Map<string, Promise<void>>();
const MAX_RETRIES = 3;

/** DB 状态抢占同时约束重试、删除和纪要生成；失败保留行和本地音频。 */
export function retryMeetingAudio(sessionId: string): Promise<void> {
  const current = running.get(sessionId);
  if (current) return current;
  const task = (async () => {
    const [claimed] = await MeetingMinutes.update({ audioStatus: 'uploading' }, {
      where: { sessionId, status: { [Op.in]: ['ended', 'failed'] },
        audioStatus: { [Op.in]: ['pending', 'failed'] }, summaryStatus: { [Op.ne]: 'generating' } },
    });
    if (!claimed) throw new Error('audio_busy');
    let record: MeetingMinutes | null = null;
    try {
      record = await MeetingMinutes.findByPk(sessionId);
      if (!record) return;
      publishMeetingChange(record.userId, sessionId);
      const loaded = await meetingAudioStore.loadManifest(sessionId);
      const manifest = loaded.ok ? loaded.manifest : await meetingAudioStore.recoverManifest(sessionId);
      const encoded = await meetingAudioStore.encodeWav(sessionId, 16000, manifest.lastAcceptedAudioIndex);
      if (!encoded.filePath && manifest.acceptedSamples > 0) throw new Error('confirmed_audio_missing');
      const uploaded = encoded.filePath
        ? await meetingAudioStore.uploadToQiniu(sessionId, record.audioStorageRef) : null;
      await record.update({
        audioStatus: !uploaded ? 'missing' : manifest.clientComplete && encoded.complete ? 'ready' : 'partial',
        audioStorageRef: uploaded?.storageRef ?? null, audioError: null, audioSize: uploaded ? encoded.dataBytes + 44 : 0,
        durationSeconds: Math.floor(encoded.samples / 16000), audioRetryAt: null,
      });
      publishMeetingChange(record.userId, sessionId);
      if (record.summaryError !== FINAL_TRANSCRIPT_FAILED) {
        await meetingAudioStore.removeLocal(sessionId).catch(error =>
          record.update({ audioRetryAt: new Date(Date.now() + 60_000), audioError: 'local_cleanup_failed' }).then(() => { console.error('meeting_audio_cleanup_pending', { sessionId, message: error.message }); }));
      }
    } catch (error) {
      const retryCount = (record?.audioRetryCount ?? 0) + 1;
      await MeetingMinutes.update({ audioStatus: 'failed', audioError: (error as Error).message.slice(0, 64),
        audioRetryCount: retryCount, audioRetryAt: retryCount < MAX_RETRIES ? new Date(Date.now() + retryCount * 60_000) : null }, { where: { sessionId, audioStatus: 'uploading' } });
      if (record) publishMeetingChange(record.userId, sessionId);
      throw error;
    }
  })().finally(() => running.delete(sessionId));
  running.set(sessionId, task);
  return task;
}

export async function cleanupDeletedMeeting(record: MeetingMinutes): Promise<void> {
  const result = await meetingAudioStore.deleteRecorded(record.sessionId, record.audioStorageRef);
  if (!result.qiniu || !result.local) {
    await record.update({ audioError: 'cleanup_failed' });
    throw new Error('cleanup_failed');
  }
  await record.destroy();
}

export async function processMeetingAudioTasks(): Promise<void> {
  const rows = await MeetingMinutes.findAll({ where: { [Op.or]: [
    { status: { [Op.in]: ['ended', 'failed'] }, audioStatus: 'pending', summaryStatus: { [Op.ne]: 'generating' } },
    { audioStatus: 'failed', audioRetryAt: { [Op.lte]: new Date() }, audioRetryCount: { [Op.lt]: MAX_RETRIES }, summaryStatus: { [Op.ne]: 'generating' } },
    { audioStatus: 'deleting' },
    { audioStatus: { [Op.in]: ['ready', 'partial', 'missing'] }, audioError: { [Op.in]: ['local_cleanup_failed', 'local_cleanup_pending'] }, audioRetryAt: { [Op.lte]: new Date() } },
  ] } });
  for (const row of rows) {
    try {
      if (row.audioStatus === 'deleting') await cleanupDeletedMeeting(row);
      else if (['ready', 'partial', 'missing'].includes(row.audioStatus)) {
        await meetingAudioStore.removeLocal(row.sessionId);
        await row.update({ audioRetryAt: null, audioError: null });
      } else await retryMeetingAudio(row.sessionId);
    } catch (error) {
      console.error('meeting_audio_task_failed', { sessionId: row.sessionId, message: (error as Error).message });
    }
  }
}

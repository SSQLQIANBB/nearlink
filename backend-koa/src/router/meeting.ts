import Router from 'koa-router';
import { Op } from 'sequelize';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { MeetingMinutes, isValidSessionId } from '../models/MeetingMinutes';
import sequelize from '../config/database';
import { meetingListAttributes, publishMeetingChange, serializeMeetingListItem } from '../services/meetingChanges';
import { parsePageParams } from '../utils/meetingQuery';
import { qiniuStorage } from '../services/qiniuStorageService';
import { parseStorageReference } from '../services/qiniuStorageService';
import { cleanupDeletedMeeting, retryMeetingAudio } from '../services/meetingAudioTasks';
import { meetingRecordingService } from '../config/meetingMinutes';
import { FINAL_SUMMARY_PENDING } from '../services/meetingFinalTranscript';

const router = new Router({ prefix: '/api/meetings' });
router.use(authMiddleware);

const titleSchema = z.object({ title: z.string().trim().min(1).max(120) }).strict();

// 我的会议记录列表（分页在数据库执行；列表只返回摘要字段，不返回长文本）。
router.get('/', async (ctx) => {
  const params = parsePageParams(ctx.query as Record<string, unknown>);
  if (!params) {
    ctx.status = 400;
    ctx.body = { error: '分页参数无效' };
    return;
  }
  const { pageSize } = params;
  let { page } = params;
  const where = { userId: ctx.state.user!.userId, audioStatus: { [Op.ne]: 'deleting' } };
  const sessionId = ctx.query.sessionId;
  if (sessionId !== undefined) {
    if (typeof sessionId !== 'string' || !isValidSessionId(sessionId)) {
      ctx.status = 400;
      ctx.body = { error: 'sessionId 无效' };
      return;
    }
    const target = await MeetingMinutes.findOne({ where: { ...where, sessionId }, attributes: ['sessionId', 'createdAt'] });
    if (target) {
      const earlier = await MeetingMinutes.count({ where: { ...where, [Op.or]: [
        { createdAt: { [Op.gt]: target.createdAt } },
        { createdAt: target.createdAt, sessionId: { [Op.gt]: target.sessionId } },
      ] } });
      page = Math.floor(earlier / pageSize) + 1;
    }
  }
  const { rows, count } = await MeetingMinutes.findAndCountAll({
    where,
    order: [
      ['createdAt', 'DESC'],
      ['sessionId', 'DESC'],
    ],
    limit: pageSize,
    offset: (page - 1) * pageSize,
    attributes: meetingListAttributes,
  });
  ctx.body = {
    items: rows.map(serializeMeetingListItem),
    total: count,
    page,
    pageSize,
  };
});

// 刷新后查询当前用户是否有活动录音（服务端真实状态）；
// 前端据此提示"继续/结束"，不自动打开麦克风。
router.get('/active', async (ctx) => {
  const record = await MeetingMinutes.findOne({
    where: { userId: ctx.state.user!.userId, status: { [Op.in]: ['recording', 'paused', 'finalizing'] } },
    order: [['updatedAt', 'DESC']],
    attributes: ['sessionId', 'source', 'status', 'audioStatus', 'durationSeconds', 'audioPausedAttachDeadline'],
  });
  if (!record) {
    ctx.body = { active: false };
    return;
  }
  const plain = record.get({ plain: true }) as Record<string, unknown>;
  const deadline = plain.audioPausedAttachDeadline ? new Date(record.audioPausedAttachDeadline!).getTime() : null;
  ctx.body = {
    active: true,
    source: plain.source,
    sessionId: plain.sessionId,
    status: plain.status,
    audioStatus: plain.audioStatus,
    durationSeconds: plain.durationSeconds,
    // 暂停草稿是否仍在保留期内（可继续）；过期则只能结束/由服务端收尾。
    resumable: plain.status !== 'finalizing' && (deadline === null || deadline > Date.now()),
  };
});

router.post('/:sessionId/discard', async (ctx) => {
  const { sessionId } = ctx.params;
  if (!isValidSessionId(sessionId)) {
    ctx.status = 400;
    ctx.body = { error: 'sessionId 无效' };
    return;
  }
  try {
    if (!(await meetingRecordingService.discard(ctx.state.user!, sessionId))) {
      ctx.status = 409;
      ctx.body = { error: '录音正在收尾、已保存或仍在其他登录会话中，无法放弃' };
      return;
    }
    ctx.body = { ok: true };
  } catch (error) {
    console.error('meeting_discard_failed', { sessionId, error });
    ctx.status = 500;
    ctx.body = { error: '放弃录音失败，请重试' };
  }
});

// 会议详情（含转写与纪要）
router.get('/:sessionId', async (ctx) => {
  if (!isValidSessionId(ctx.params.sessionId)) {
    ctx.status = 400;
    ctx.body = { error: 'sessionId 无效' };
    return;
  }
  const record = await MeetingMinutes.findOne({
    where: { sessionId: ctx.params.sessionId, userId: ctx.state.user!.userId, audioStatus: { [Op.ne]: 'deleting' } },
  });
  if (!record) {
    ctx.status = 404;
    ctx.body = { error: '会议记录不存在' };
    return;
  }
  ctx.body = { meeting: serializeDetail(record) };
});

// 修改标题（重命名使用提交时的 sessionId 与 title）。
router.put('/:sessionId/title', async (ctx) => {
  if (!isValidSessionId(ctx.params.sessionId)) {
    ctx.status = 400;
    ctx.body = { error: 'sessionId 无效' };
    return;
  }
  const parsed = titleSchema.safeParse(ctx.request.body);
  if (!parsed.success) {
    ctx.status = 400;
    ctx.body = { error: '标题无效' };
    return;
  }
  const [updated] = await MeetingMinutes.update(
    { title: parsed.data.title },
    { where: { sessionId: ctx.params.sessionId, userId: ctx.state.user!.userId, audioStatus: { [Op.ne]: 'deleting' } } },
  );
  if (!updated) {
    ctx.status = 404;
    ctx.body = { error: '会议记录不存在' };
    return;
  }
  publishMeetingChange(ctx.state.user!.userId, ctx.params.sessionId, 'metadata');
  ctx.body = { ok: true };
});

// 生成/重新生成 AI 纪要。
// - 录音尚未完成（recording/paused/finalizing）不允许生成最终纪要；
// - 同一会议只允许一个纪要生成操作，服务端以 summaryStatus 拦截并发；
// - 生成失败保留上一份成功纪要，只更新 summaryStatus/summaryError。
router.post('/:sessionId/summary', async (ctx) => {
  if (!isValidSessionId(ctx.params.sessionId)) {
    ctx.status = 400;
    ctx.body = { error: 'sessionId 无效' };
    return;
  }
  const record = await MeetingMinutes.findOne({
    where: { sessionId: ctx.params.sessionId, userId: ctx.state.user!.userId, audioStatus: { [Op.ne]: 'deleting' } },
  });
  if (!record) {
    ctx.status = 404;
    ctx.body = { error: '会议记录不存在' };
    return;
  }
  const recordingActive = ['recording', 'paused', 'finalizing'].includes(record.status);
  if (recordingActive) {
    ctx.status = 400;
    ctx.body = { error: '录音尚未结束，不能生成纪要' };
    return;
  }
  if (record.summaryStatus === 'generating') {
    ctx.status = 409;
    ctx.body = { error: '纪要正在生成中，请稍候' };
    return;
  }
  if (!record.transcript?.trim()) {
    ctx.status = 400;
    ctx.body = { error: '暂无转写内容，无法生成纪要' };
    return;
  }
  if (!(await meetingRecordingService.queueSummaryRegeneration(record.sessionId, record.userId))) {
    ctx.status = 409;
    ctx.body = { error: '纪要正在生成中，请稍候' };
    return;
  }
  record.set({ summaryStatus: 'generating', summaryError: FINAL_SUMMARY_PENDING });
  ctx.status = 202;
  ctx.body = { meeting: serializeDetail(record) };
});

router.post('/:sessionId/transcript', async (ctx) => {
  const { sessionId } = ctx.params;
  if (!isValidSessionId(sessionId)) {
    ctx.status = 400;
    ctx.body = { error: 'sessionId 无效' };
    return;
  }
  if (!(await meetingRecordingService.queueTranscriptRegeneration(sessionId, ctx.state.user!.userId))) {
    ctx.status = 409;
    ctx.body = { error: '录音暂不可用，或正在生成，请稍后重试' };
    return;
  }
  ctx.status = 202;
  ctx.body = { ok: true };
});

async function claimMeetingDeletion(userId: number, sessionIds: string[]) {
  const result = await sequelize.transaction(async transaction => {
    const where = { userId, sessionId: { [Op.in]: sessionIds }, audioStatus: { [Op.ne]: 'deleting' } };
    const records = await MeetingMinutes.findAll({
      where, order: [['sessionId', 'ASC']], transaction, lock: transaction.LOCK.UPDATE,
    });
    if (records.length !== sessionIds.length) return { error: 'missing' } as const;
    if (records.some(record => !['ended', 'failed'].includes(record.status) ||
      ['recording', 'pending', 'uploading'].includes(record.audioStatus) || record.summaryStatus === 'generating')) {
      return { error: 'busy' } as const;
    }
    await MeetingMinutes.update({ audioStatus: 'deleting' }, { where, transaction });
    return { records };
  });
  if (result.records) {
    for (const record of result.records) publishMeetingChange(userId, record.sessionId, 'removed');
  }
  return result;
}

router.post('/batch-delete', async (ctx) => {
  const parsed = z.object({ sessionIds: z.array(z.string().uuid()).min(1).max(50) }).strict().safeParse(ctx.request.body);
  if (!parsed.success) {
    ctx.status = 400;
    ctx.body = { error: '请选择 1 至 50 条有效的会议记录' };
    return;
  }
  const sessionIds = [...new Set(parsed.data.sessionIds)];
  const result = await claimMeetingDeletion(ctx.state.user!.userId, sessionIds);
  if (result.error) {
    ctx.status = result.error === 'missing' ? 404 : 409;
    ctx.body = { error: result.error === 'missing' ? '部分会议记录已不存在，请刷新后重选' : '部分会议仍在处理中，本次没有删除任何记录' };
    return;
  }
  // 始终由已有后台任务清理批量标记的对象，避免请求等待七牛。
  ctx.status = 202;
  ctx.body = { deletedCount: sessionIds.length };
});

router.delete('/:sessionId', async (ctx) => {
  if (!isValidSessionId(ctx.params.sessionId)) {
    ctx.status = 400;
    ctx.body = { error: 'sessionId 无效' };
    return;
  }
  const result = await claimMeetingDeletion(ctx.state.user!.userId, [ctx.params.sessionId]);
  if (result.error) {
    ctx.status = result.error === 'missing' ? 404 : 409;
    ctx.body = { error: result.error === 'missing' ? '会议记录不存在' : '会议正在处理中，请稍后删除' };
    return;
  }
  try {
    await cleanupDeletedMeeting(result.records[0]);
    ctx.body = { ok: true };
  } catch {
    ctx.status = 202;
    ctx.body = { ok: true, warning: '会议已移除，音频将在后台继续清理' };
  }
});

router.post('/:sessionId/audio/retry', async ctx => {
  const { sessionId } = ctx.params;
  if (!isValidSessionId(sessionId)) { ctx.status = 400; return; }
  const record = await MeetingMinutes.findOne({ where: { sessionId, userId: ctx.state.user!.userId } });
  if (!record) { ctx.status = 404; return; }
  if (record.audioStatus !== 'failed' || !['ended', 'failed'].includes(record.status)) {
    ctx.status = 409; ctx.body = { error: '音频正在处理或不需要重试' }; return;
  }
  try {
    await retryMeetingAudio(sessionId);
    await record.reload();
    ctx.body = { meeting: serializeDetail(record) };
  } catch {
    ctx.status = 503; ctx.body = { error: '音频保存重试失败，请检查存储服务后重试' };
  }
});

function serializeDetail(record: MeetingMinutes) {
  const plain = record.get({ plain: true }) as Record<string, unknown>;
  const keyPoints = plain.keyPoints ? safeJson(plain.keyPoints) : [];
  const audioStatus = (plain.audioStatus ?? 'missing') as string;
  const audioStorageRef = (plain.audioStorageRef ?? null) as string | null;
  // 仅 ready/partial 且对象引用有效时生成播放地址（私有空间签名 URL）；
  // 签名过期后前端重新请求详情即可换新地址，数据库只存稳定对象引用。
  let audioUrl: string | null = null;
  let audioDownloadUrl: string | null = null;
  if (audioStorageRef && (audioStatus === 'ready' || audioStatus === 'partial')) {
    try {
      if (parseStorageReference(audioStorageRef)) {
        audioUrl = qiniuStorage.resolveUrl(audioStorageRef);
        audioDownloadUrl = qiniuStorage.resolveUrl(audioStorageRef, `会议录音-${record.sessionId}.wav`);
      }
    } catch {
      audioUrl = null;
    }
  }
  return {
    ...serializeMeetingListItem(record),
    sourceLanguage: plain.sourceLanguage,
    targetLanguage: plain.targetLanguage,
    audioStatus,
    audioUrl,
    audioDownloadUrl,
    audioSize: plain.audioSize ?? null,
    audioError: audioStatus === 'failed' ? 'audio_save_failed' : null,
    transcript: plain.transcript,
    transcriptJson: safeJson(plain.transcriptJson),
    summary: plain.summary ?? '',
    keyPoints: Array.isArray(keyPoints) ? keyPoints : [],
    mindmap: plain.mindmap ?? '',
  };
}

function safeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export default router;

import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import Koa from 'koa';
import { koaBody } from 'koa-body';
import { Op } from 'sequelize';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

const models = vi.hoisted(() => ({ findAll: vi.fn(), findOne: vi.fn(), findAndCountAll: vi.fn(), count: vi.fn(), update: vi.fn() }));
vi.mock('../../../src/models/MeetingMinutes', () => ({
  MeetingMinutes: models,
  isValidSessionId: (value: unknown) => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value),
}));
vi.mock('../../../src/config/database', () => ({
  default: { transaction: async (action: (transaction: object) => Promise<unknown>) => action({ LOCK: { UPDATE: true } }) },
}));
vi.mock('../../../src/services/loginSessionService', () => ({ validateAuthenticatedSession: async () => ({ userId: 7 }) }));
vi.mock('../../../src/config/meetingMinutes', () => ({ meetingRecordingService: {} }));
vi.mock('../../../src/services/meetingAudioTasks', () => ({ cleanupDeletedMeeting: vi.fn(), retryMeetingAudio: vi.fn() }));

import meetingRouter from '../../../src/router/meeting';
import { observeMeetingChanges, publishMeetingChange } from '../../../src/services/meetingChanges';

let server: Server;
let origin: string;
beforeAll(async () => {
  const app = new Koa();
  app.use(koaBody());
  app.use(meetingRouter.routes());
  server = createServer(app.callback());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/meetings`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => vi.resetAllMocks());

const headers = { Authorization: 'Bearer valid', 'Content-Type': 'application/json' };
const batchDelete = (sessionIds: string[]) => fetch(`${origin}/batch-delete`, { method: 'POST', headers, body: JSON.stringify({ sessionIds }) });

it('按会话定位列表页，按创建时间和会话 ID 区分同时间的记录', async () => {
  const sessionId = randomUUID();
  const createdAt = new Date('2026-11-18T10:00:00Z');
  models.findOne.mockResolvedValue({ sessionId, createdAt });
  models.count.mockResolvedValue(42);
  models.findAndCountAll.mockResolvedValue({ rows: [], count: 50 });
  const response = await fetch(`${origin}?pageSize=20&sessionId=${sessionId}`, { headers });
  await expect(response.json()).resolves.toMatchObject({ page: 3, total: 50 });
  expect(models.count.mock.calls[0][0].where).toMatchObject({ userId: 7, [Op.or]: [
    { createdAt: { [Op.gt]: createdAt } }, { createdAt, sessionId: { [Op.gt]: sessionId } },
  ] });
  expect(models.findAndCountAll).toHaveBeenCalledWith(expect.objectContaining({ offset: 40 }));
});

it('批量删除在事务中校验归属和整批状态，冲突时不标记任何记录', async () => {
  const first = randomUUID(), second = randomUUID();
  models.findAll.mockResolvedValueOnce([{ sessionId: first, status: 'ended', audioStatus: 'ready' }]);
  expect((await batchDelete([first, second])).status).toBe(404);
  models.findAll.mockResolvedValueOnce([
    { sessionId: first, status: 'ended', audioStatus: 'ready' },
    { sessionId: second, status: 'ended', audioStatus: 'ready', summaryStatus: 'generating' },
  ]);
  expect((await batchDelete([first, second])).status).toBe(409);
  expect(models.update).not.toHaveBeenCalled();
  expect(models.findAll.mock.calls[0][0]).toMatchObject({ lock: true, where: { userId: 7, sessionId: { [Op.in]: [first, second] } } });
});

it('仅推送给归属用户，批量标记成功后推送删除事件', async () => {
  const first = randomUUID(), second = randomUUID();
  const push = vi.fn();
  const stop = observeMeetingChanges(userId => userId === 7 ? ['own-socket'] : [], push);
  try {
    const row = { sessionId: first, title: '测试会议', transcript: '不随事件发送',
      status: 'ended', summaryStatus: 'generating', summaryError: 'regenerate_transcript_pending' };
    models.findOne.mockResolvedValue({ ...row, get: () => row });
    publishMeetingChange(8, first);
    publishMeetingChange(7, first);
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(push.mock.calls[0][0]).toEqual(['own-socket']);
    expect(push.mock.calls[0][1]).toMatchObject({
      sessionId: first, item: { title: '测试会议', generationStage: 'transcript', regeneratingTranscript: true }, detailChanged: true,
    });
    expect(models.findOne).toHaveBeenCalledWith(expect.objectContaining({ attributes: expect.arrayContaining(['summaryError']) }));
    expect(push.mock.calls[0][1].item).not.toHaveProperty('transcript');
    models.findAll.mockResolvedValue([first, second].map(sessionId => ({ sessionId, status: 'ended', audioStatus: 'ready' })));
    models.update.mockResolvedValue([2]);
    const response = await batchDelete([first, second]);
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ deletedCount: 2 });
    expect(push).toHaveBeenCalledWith(['own-socket'], { sessionId: second, item: null, detailChanged: true });
  } finally {
    stop();
  }
});

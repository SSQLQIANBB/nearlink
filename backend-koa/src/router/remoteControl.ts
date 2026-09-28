import { assistanceDuration, assistanceExpiry, activeAssistanceWhere } from '../services/assistanceGrantPolicy';
import Router from 'koa-router';
import { Op } from 'sequelize';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import redis from '../config/redis';
import { AssistanceGrant, RemoteDevice, RemoteSessionRecord } from '../models/RemoteControl';
import { validateAuthenticatedSession } from '../services/loginSessionService';
import { REMOTE_HISTORY_RETENTION_MS } from '../services/remoteControlRetention';
import { getRemoteControlCapabilities } from '../services/remoteControlPolicy';
import { RemoteControlError, uuid } from '../services/remoteControlProtocol';
import { deviceRegistrationSchema, RemoteDeviceChallengeStore, verifyRegistrationProof } from '../services/remoteDeviceProof';
import { remoteCredentialSignerFromEnvironment } from '../services/remoteCredentials';
import { RemoteIceService, turnSettingsFromEnvironment } from '../services/remoteIce';
import { RedisRemoteSessionStore } from '../services/redisRemoteSessionStore';
import { RemoteSessionHistory } from '../services/remoteSessionHistory';
import { getRemoteControlContext } from '../services/remoteControlContext';
import User from '../models/User';

const router = new Router({ prefix: '/api/remote-control' });
const challenges = new RemoteDeviceChallengeStore(redis);
const ice = new RemoteIceService(new RedisRemoteSessionStore(redis), new RemoteSessionHistory(), turnSettingsFromEnvironment, remoteCredentialSignerFromEnvironment);
const safeDevice = (device: RemoteDevice) => ({ deviceId: device.id, alias: device.alias, platform: device.platform,
  revokedAt: device.revokedAt, createdAt: device.createdAt });

router.use(async (ctx, next) => {
  try {
    const token = /^Bearer ([^\s]+)$/.exec(ctx.headers.authorization || '')?.[1];
    if (!token) throw new RemoteControlError('AUTH_REQUIRED', 401);
    try { ctx.state.remoteAuth = await validateAuthenticatedSession(token); }
    catch { throw new RemoteControlError('AUTH_REVOKED', 401); }
    await next();
  } catch (error) {
    if (error instanceof RemoteControlError) { ctx.status = error.status; ctx.body = { error: error.code, code: error.code }; }
    else if (error instanceof z.ZodError) { ctx.status = 400; ctx.body = { error: 'INVALID_REQUEST', code: 'INVALID_REQUEST' }; }
    else {
      // Do not expose credentials, SQL, device identities or candidate contents in responses/logs.
      ctx.status = 503; ctx.body = { error: 'REMOTE_SERVICE_UNAVAILABLE', code: 'REMOTE_SERVICE_UNAVAILABLE' };
      console.error('remote_control_request_failed', { route: ctx.path, type: error instanceof Error ? error.name : 'UnknownError' });
    }
  }
});

router.get('/capabilities', ctx => { ctx.set('Cache-Control', 'no-store'); ctx.body = getRemoteControlCapabilities(ctx.state.remoteAuth.userId); });
router.get('/signing-keys', ctx => {
  const signer = remoteCredentialSignerFromEnvironment();
  ctx.set('Cache-Control', 'no-store');
  // Only explicit server configuration supplies keys. No token/URL can add a trust anchor.
  ctx.body = { keys: signer ? [signer.publicKey] : [] };
});
router.get('/devices', async ctx => {
  const devices = await RemoteDevice.findAll({ where: { ownerUserId: ctx.state.remoteAuth.userId }, limit: 100, order: [['createdAt', 'DESC']] });
  ctx.body = { devices: devices.map(safeDevice) };
});

router.post('/device-challenges', async ctx => {
  z.object({}).strict().parse(ctx.request.body || {});
  const { userId, sid } = ctx.state.remoteAuth;
  const count = Number(await redis.eval(`local n=redis.call('INCR', KEYS[1]); if n==1 then redis.call('PEXPIRE', KEYS[1], 60000) end; return n`, 1, `remote:challenge-rate:${userId}`));
  if (count > 5) throw new RemoteControlError('RATE_LIMITED', 429);
  ctx.body = { challenge: await challenges.create(userId, sid) };
});

router.post('/devices', async ctx => {
  const input = deviceRegistrationSchema.parse(ctx.request.body);
  const { userId, sid } = ctx.state.remoteAuth;
  const challenge = await challenges.consume(input.challengeId, userId, sid);
  const proof = verifyRegistrationProof(challenge, input, userId, sid, Date.now());
  const [device] = await RemoteDevice.findOrCreate({
    where: { fingerprint: proof.fingerprint },
    defaults: { id: randomUUID(), ownerUserId: userId, ...proof, alias: input.alias, platform: input.platform },
  });
  if (device.ownerUserId !== userId || device.revokedAt) throw new RemoteControlError('DEVICE_KEY_UNAVAILABLE', 403);
  // Registration proves key ownership only. It never marks this device online or control-capable.
  ctx.body = { device: safeDevice(device) };
});

router.patch('/devices/:id', async ctx => {
  const id = uuid.parse(ctx.params.id);
  const { alias } = z.object({ alias: z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/) }).strict().parse(ctx.request.body);
  const where = { id, ownerUserId: ctx.state.remoteAuth.userId, revokedAt: null };
  // Scope the write itself: a concurrent revocation must not permit a later rename.
  await RemoteDevice.update({ alias }, { where });
  const device = await RemoteDevice.findOne({ where });
  if (!device) throw new RemoteControlError('TARGET_UNAVAILABLE', 404);
  ctx.set('Cache-Control', 'no-store');
  ctx.body = { device: safeDevice(device) };
});

router.delete('/devices/:id', async ctx => {
  const id = uuid.parse(ctx.params.id);
  const device = await RemoteDevice.findOne({ where: { id, ownerUserId: ctx.state.remoteAuth.userId } });
  if (!device) throw new RemoteControlError('TARGET_UNAVAILABLE', 404);
  await device.update({ revokedAt: device.revokedAt || new Date() });
  await AssistanceGrant.update({ revokedAt: new Date() }, { where: { hostDeviceId: id, revokedAt: null } });
  ctx.body = { ok: true };
});

router.get('/targets', async ctx => {
  const { userId } = z.object({ userId: z.coerce.number().int().positive().safe() }).strict().parse(ctx.query);
  const { authority, store } = getRemoteControlContext();
  if (!authority || !getRemoteControlCapabilities(ctx.state.remoteAuth.userId).desktopHostEnabled) { ctx.body = { targets: [] }; return; }
  const grants = await AssistanceGrant.findAll({ where: { controllerUserId: ctx.state.remoteAuth.userId,
    ...activeAssistanceWhere() }, limit: 100 });
  const devices = await RemoteDevice.findAll({ where: { id: { [Op.in]: grants.map(g => g.hostDeviceId) }, ownerUserId: userId, revokedAt: null }, limit: 100 });
  const targets = await Promise.all(devices.map(async device => {
    const host = authority.host(device.id);
    if (!host) return null;
    // A renewed socket heartbeat alone cannot keep a revoked login/device visible.
    try { await authority.assertCurrent(host.endpoint); } catch { return null; }
    return { deviceId: device.id, alias: device.alias, platform: device.platform, online: true,
      busy: await store.occupied(device.id), canHostView: !!host.presence?.canCapture, canHostControl: !!host.presence?.canControl };
  }));
  ctx.body = { targets: targets.filter(Boolean) };
});
router.post('/assistance-grants', async ctx => {
  const input = z.object({ hostDeviceId: uuid, controllerUserId: z.number().int().positive().safe(), duration: assistanceDuration.default('15m') }).strict().parse(ctx.request.body);
  if (!getRemoteControlCapabilities(ctx.state.remoteAuth.userId).desktopHostEnabled) throw new RemoteControlError('NATIVE_VALIDATION_PENDING', 503);
  const { userId, sid } = ctx.state.remoteAuth;
  const result = await AssistanceGrant.sequelize!.transaction(async transaction => {
    const device = await RemoteDevice.findOne({ where: { id: input.hostDeviceId, ownerUserId: userId, revokedAt: null }, transaction, lock: transaction.LOCK.UPDATE });
    if (!device || !await User.findByPk(input.controllerUserId, { attributes: ['id'], transaction })) throw new RemoteControlError('TARGET_UNAVAILABLE', 404);
    const existing = await AssistanceGrant.findAll({ where: { hostDeviceId: device.id, ...activeAssistanceWhere() }, transaction, limit: 20 });
    const prior = existing.find(g => g.controllerUserId === input.controllerUserId && g.createdBySid === sid);
    if (prior) { await prior.update({ expiresAt: assistanceExpiry(input.duration) }, { transaction }); return prior; }
    if (existing.length >= 20) throw new RemoteControlError('GRANT_LIMIT', 429);
    return AssistanceGrant.create({ id: randomUUID(), hostDeviceId: device.id, createdBySid: sid,
      controllerUserId: input.controllerUserId, expiresAt: assistanceExpiry(input.duration) }, { transaction });
  });
  // This only permits requesting a native prompt, never screen capture or input.
  ctx.body = { grant: { id: result.id, hostDeviceId: result.hostDeviceId, controllerUserId: result.controllerUserId, expiresAt: result.expiresAt } };
});
router.get('/assistance-grants', async ctx => {
  const devices = await RemoteDevice.findAll({ where: { ownerUserId: ctx.state.remoteAuth.userId, revokedAt: null }, attributes: ['id'], limit: 100 });
  const grants = await AssistanceGrant.findAll({ where: { hostDeviceId: { [Op.in]: devices.map(d => d.id) },
    ...activeAssistanceWhere() }, limit: 100, order: [['expiresAt', 'DESC']] });
  ctx.body = { grants: grants.map(g => ({ id: g.id, hostDeviceId: g.hostDeviceId, controllerUserId: g.controllerUserId, expiresAt: g.expiresAt })) };
});
router.delete('/assistance-grants/:id', async ctx => {
  const id = uuid.parse(ctx.params.id);
  const grant = await AssistanceGrant.findByPk(id);
  const owner = grant && await RemoteDevice.findOne({ where: { id: grant.hostDeviceId, ownerUserId: ctx.state.remoteAuth.userId } });
  if (!grant || !owner) throw new RemoteControlError('TARGET_UNAVAILABLE', 404);
  await grant.update({ revokedAt: grant.revokedAt || new Date() });
  ctx.body = { ok: true };
});
router.get('/sessions', async ctx => {
  const userId = ctx.state.remoteAuth.userId;
  const records = await RemoteSessionRecord.findAll({
    where: { [Op.or]: [{ controllerUserId: userId }, { hostUserId: userId }], createdAt: { [Op.gte]: new Date(Date.now() - REMOTE_HISTORY_RETENTION_MS) } },
    order: [['createdAt', 'DESC']], limit: 50,
  });
  ctx.body = { sessions: records.map(record => ({
    sessionId: record.sessionId, state: record.state, revision: record.revision, createdAt: record.createdAt,
    endedAt: record.endedAt, endReason: record.endReason, hostDeviceId: record.hostDeviceId, scope: record.scope,
  })) };
});
router.get('/sessions/:id/ice', async ctx => {
  ctx.set('Cache-Control', 'no-store');
  ctx.body = await ice.issue(uuid.parse(ctx.params.id), ctx.state.remoteAuth);
});

export default router;

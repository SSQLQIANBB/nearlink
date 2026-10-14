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
import {
  deviceRegistrationSchema,
  RemoteDeviceChallengeStore,
  verifyRegistrationProof,
} from '../services/remoteDeviceProof';
import { remoteCredentialSignerFromEnvironment } from '../services/remoteCredentials';
import { RemoteIceService, turnSettingsFromEnvironment } from '../services/remoteIce';
import { RedisRemoteSessionStore } from '../services/redisRemoteSessionStore';
import { getRemoteControlContext } from '../services/remoteControlContext';

const router = new Router({ prefix: '/api/remote-control' });
const challenges = new RemoteDeviceChallengeStore(redis);
const ice = new RemoteIceService(
  new RedisRemoteSessionStore(redis),
  { assertAuthorized: (session) => getRemoteControlContext().history.assertAuthorized(session) },
  turnSettingsFromEnvironment,
  remoteCredentialSignerFromEnvironment,
);
const safeDevice = (device: RemoteDevice) => ({
  deviceId: device.id,
  alias: device.alias,
  platform: device.platform,
  revokedAt: device.revokedAt,
  createdAt: device.createdAt,
});

router.use(async (ctx, next) => {
  try {
    const token = /^Bearer ([^\s]+)$/.exec(ctx.headers.authorization || '')?.[1];
    if (!token) throw new RemoteControlError('AUTH_REQUIRED', 401);
    try {
      ctx.state.remoteAuth = await validateAuthenticatedSession(token);
    } catch {
      throw new RemoteControlError('AUTH_REVOKED', 401);
    }
    await next();
  } catch (error) {
    if (error instanceof RemoteControlError) {
      ctx.status = error.status;
      ctx.body = { error: error.code, code: error.code };
    } else if (error instanceof z.ZodError) {
      ctx.status = 400;
      ctx.body = { error: 'INVALID_REQUEST', code: 'INVALID_REQUEST' };
    } else {
      // Do not expose credentials, SQL, device identities or candidate contents in responses/logs.
      ctx.status = 503;
      ctx.body = { error: 'REMOTE_SERVICE_UNAVAILABLE', code: 'REMOTE_SERVICE_UNAVAILABLE' };
      console.error('remote_control_request_failed', {
        route: ctx.path,
        type: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }
});

router.get('/capabilities', (ctx) => {
  ctx.set('Cache-Control', 'no-store');
  ctx.body = getRemoteControlCapabilities();
});
router.get('/signing-keys', (ctx) => {
  const signer = remoteCredentialSignerFromEnvironment();
  ctx.set('Cache-Control', 'no-store');
  // Only explicit server configuration supplies keys. No token/URL can add a trust anchor.
  ctx.body = { keys: signer ? [signer.publicKey] : [] };
});
router.post('/device-challenges', async (ctx) => {
  z.object({})
    .strict()
    .parse(ctx.request.body || {});
  const { userId, sid } = ctx.state.remoteAuth;
  const count = Number(
    await redis.eval(
      `local n=redis.call('INCR', KEYS[1]); if n==1 then redis.call('PEXPIRE', KEYS[1], 60000) end; return n`,
      1,
      `remote:challenge-rate:${userId}`,
    ),
  );
  if (count > 5) throw new RemoteControlError('RATE_LIMITED', 429);
  ctx.body = { challenge: await challenges.create(userId, sid) };
});

router.post('/devices', async (ctx) => {
  const input = deviceRegistrationSchema.parse(ctx.request.body);
  const { userId, sid } = ctx.state.remoteAuth;
  const challenge = await challenges.consume(input.challengeId, userId, sid);
  const proof = verifyRegistrationProof(challenge, input, userId, sid, Date.now());
  const [device] = await RemoteDevice.findOrCreate({
    where: { fingerprint: proof.fingerprint },
    defaults: {
      id: randomUUID(),
      ownerUserId: userId,
      ...proof,
      alias: input.alias,
      platform: input.platform,
    },
  });
  if (device.ownerUserId !== userId || device.revokedAt)
    throw new RemoteControlError('DEVICE_KEY_UNAVAILABLE', 403);
  // Registration proves key ownership only. It never marks this device online or control-capable.
  ctx.body = { device: safeDevice(device) };
});

router.delete('/assistance-grants/:id', async (ctx) => {
  const id = uuid.parse(ctx.params.id);
  const grant = await AssistanceGrant.findByPk(id);
  const owner =
    grant &&
    (await RemoteDevice.findOne({
      where: { id: grant.hostDeviceId, ownerUserId: ctx.state.remoteAuth.userId },
    }));
  if (!grant || !owner) throw new RemoteControlError('TARGET_UNAVAILABLE', 404);
  await grant.update({ revokedAt: grant.revokedAt || new Date() });
  ctx.body = { ok: true };
});
router.get('/sessions', async (ctx) => {
  const userId = ctx.state.remoteAuth.userId;
  const records = await RemoteSessionRecord.findAll({
    where: {
      [Op.or]: [{ controllerUserId: userId }, { hostUserId: userId }],
      createdAt: { [Op.gte]: new Date(Date.now() - REMOTE_HISTORY_RETENTION_MS) },
    },
    order: [['createdAt', 'DESC']],
    limit: 50,
  });
  ctx.body = {
    sessions: records.map((record) => ({
      sessionId: record.sessionId,
      state: record.state,
      revision: record.revision,
      createdAt: record.createdAt,
      endedAt: record.endedAt,
      endReason: record.endReason,
      hostDeviceId: record.hostDeviceId,
      scope: record.scope,
    })),
  };
});
router.get('/sessions/:id/ice', async (ctx) => {
  ctx.set('Cache-Control', 'no-store');
  ctx.body = await ice.issue(uuid.parse(ctx.params.id), ctx.state.remoteAuth);
});

export default router;

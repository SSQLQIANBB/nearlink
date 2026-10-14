import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID, createHash } from 'crypto';
import Redis from 'ioredis';

const testUrl = process.env.AUTH_TEST_MYSQL_URL;
if (testUrl && !/^todesk_auth_test_[a-zA-Z0-9_]+$/.test(new URL(testUrl).pathname.slice(1)))
  throw new Error('Disposable test database required');
vi.mock('../../src/config/database', async () => {
  const { Sequelize } = await import('sequelize');
  return {
    default: new Sequelize(
      process.env.AUTH_TEST_MYSQL_URL || 'mysql://root@127.0.0.1/todesk_auth_test_disabled',
      { logging: false },
    ),
  };
});
import db from '../../src/config/database';
import User from '../../src/models/User';
import LoginSession from '../../src/models/LoginSession';
import {
  RemoteDevice,
  AssistanceGrant,
  RemoteSessionRecord,
  RemoteSessionEvent,
} from '../../src/models/RemoteControl';
import {
  createLoginSession,
  replacePasswordAndRevokeSessions,
  revokeLoginSession,
} from '../../src/services/loginSessionService';
import { RedisRemoteSessionStore } from '../../src/services/redisRemoteSessionStore';
import { RemoteControlService } from '../../src/services/remoteControlService';
import { RemoteControlRuntime } from '../../src/services/remoteControlRuntime';
import { RemoteSessionHistory } from '../../src/services/remoteSessionHistory';
import { REMOTE_HISTORY_RETENTION_MS } from '../../src/services/remoteControlRetention';

const suite = testUrl ? describe : describe.skip;
suite('remote lifecycle (isolated MySQL + Redis)', () => {
  let directory: string, child: ChildProcess, redis: Redis;
  let store: RedisRemoteSessionStore,
    history: RemoteSessionHistory,
    service: RemoteControlService,
    runtime: RemoteControlRuntime;
  let now: number,
    controller: User,
    host: User,
    controllerLogin: Awaited<ReturnType<typeof createLoginSession>>;
  let hostLogin: Awaited<ReturnType<typeof createLoginSession>>,
    creatorLogin: Awaited<ReturnType<typeof createLoginSession>>;
  const errors = vi.fn();
  const models = [
    User,
    LoginSession,
    RemoteDevice,
    AssistanceGrant,
    RemoteSessionRecord,
    RemoteSessionEvent,
  ];
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'td-runtime-'));
    const socket = join(directory, 'redis.sock');
    child = spawn(
      process.env.REDIS_TEST_BINARY || 'redis-server',
      [
        '--port',
        '0',
        '--unixsocket',
        socket,
        '--unixsocketperm',
        '700',
        '--save',
        '',
        '--appendonly',
        'no',
        '--dir',
        directory,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Redis startup timeout')), 10_000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.stdout!.on('data', (value) => {
        if (/ready to accept connections/i.test(String(value))) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    redis = new Redis(socket, { maxRetriesPerRequest: 1, retryStrategy: () => null });
    await redis.ping();
    for (const model of models) await model.sync({ force: true });
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    errors.mockClear();
    await redis.flushdb();
    for (const model of [...models].reverse()) await model.destroy({ where: {} });
    controller = await User.create({ username: 'controller', password: 'hash' });
    host = await User.create({ username: 'host', password: 'hash' });
    controllerLogin = await createLoginSession(controller.id);
    hostLogin = await createLoginSession(host.id);
    creatorLogin = await createLoginSession(host.id);
    now = Date.now();
    store = new RedisRemoteSessionStore(redis);
    history = new RemoteSessionHistory();
    service = new RemoteControlService(store, () => Math.max(now, Date.now()), history);
    runtime = new RemoteControlRuntime(service, store, history, {
      now: () => Math.max(now, Date.now()),
      batchSize: 2,
      reportError: errors,
    });
  });
  afterAll(async () => {
    for (const model of [...models].reverse()) await model.drop();
    await db.close();
    if (redis) await redis.quit();
    if (child?.exitCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await exited;
    }
    if (directory) await rm(directory, { force: true, recursive: true });
  });
  async function input() {
    const device = await RemoteDevice.create({
      id: randomUUID(),
      ownerUserId: host.id,
      publicKey: 'test-public-key',
      fingerprint: createHash('sha256').update(randomUUID()).digest('hex'),
      alias: 'Test device',
      platform: 'macos',
    });
    const grant = await AssistanceGrant.create({
      id: randomUUID(),
      hostDeviceId: device.id,
      createdBySid: creatorLogin.loginSessionId,
      controllerUserId: controller.id,
      expiresAt: new Date(Date.now() + 600_000),
    });
    return {
      requestId: randomUUID(),
      grantId: grant.id,
      grantCreatedBySid: creatorLogin.loginSessionId,
      scope: 'control' as const,
      controller: {
        userId: controller.id,
        sid: controllerLogin.loginSessionId,
        authVersion: controller.authVersion,
        endpointId: randomUUID(),
        connectionId: randomUUID(),
        generation: 1,
      },
      host: {
        userId: host.id,
        sid: hostLogin.loginSessionId,
        authVersion: host.authVersion,
        endpointId: device.id,
        connectionId: randomUUID(),
        generation: 1,
      },
    };
  }

  it('history failure rejects admission before Redis locks; missing writer also fails closed', async () => {
    const request = await input();
    await expect(new RemoteControlService(store).request(request)).rejects.toThrow(
      'HISTORY_UNAVAILABLE',
    );
    await db.query(
      "CREATE TRIGGER reject_remote_history BEFORE INSERT ON remote_sessions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='history unavailable'",
    );
    try {
      await expect(service.request(request)).rejects.toThrow('history unavailable');
      expect(await redis.keys('remote:*occupied:*')).toHaveLength(0);
      expect(await RemoteSessionRecord.count()).toBe(0);
    } finally {
      await db.query('DROP TRIGGER reject_remote_history');
    }
  });
  it('concurrent durable request identity creates one history/event and one live session', async () => {
    const request = await input();
    const results = await Promise.allSettled([service.request(request), service.request(request)]);
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    expect(await RemoteSessionRecord.count()).toBe(1);
    expect(await RemoteSessionEvent.count()).toBe(1);
    const retry = await service.request(request);
    expect(retry.created).toBe(false);
    await expect(service.request({ ...request, scope: 'view' })).rejects.toThrow(
      'IDEMPOTENCY_CONFLICT',
    );
  });
  it('timeout batches are bounded and archive terminal history idempotently', async () => {
    const sessions = [];
    for (let i = 0; i < 3; i++) sessions.push((await service.request(await input())).session);
    now += 46_000;
    await runtime.tick();
    expect(
      (await Promise.all(sessions.map((session) => store.get(session.id)))).filter(
        (session) => session!.state === 'ended',
      ),
    ).toHaveLength(2);
    await runtime.tick();
    expect(await RemoteSessionRecord.count({ where: { state: 'ended' } })).toBe(3);
    expect(await RemoteSessionEvent.count({ where: { eventType: 'ended' } })).toBe(3);
    const terminal = (await store.get(sessions[0].id))!;
    await Promise.all([history.archiveEnd(terminal), history.archiveEnd(terminal)]);
    expect(await RemoteSessionEvent.count({ where: { sessionId: terminal.id } })).toBe(2);
  });
  it('a stale timeout cleanup cannot delete an extended active deadline', async () => {
    const request = await input();
    const { session } = await service.request(request);
    let live = await service.act(session.id, request.host, 0, {
      type: 'respond',
      accepted: true,
      scope: 'view',
    });
    live = await service.act(session.id, request.host, live.revision, { type: 'ready' });
    live = await service.act(session.id, request.controller, live.revision, { type: 'ready' });
    now = session.deadline + 1;
    await store.removeDeadline(session.id, now);
    await runtime.tick();
    expect((await store.get(session.id))!.state).toBe('active');
    expect(Number(await redis.zscore('remote:{remote-control}:deadlines', session.id))).toBe(
      live.deadline,
    );
  });
  it('ending does not wait for MySQL; failed archival retries without losing the Redis event', async () => {
    const { session } = await service.request(await input());
    await db.query(
      "CREATE TRIGGER reject_remote_archive BEFORE UPDATE ON remote_sessions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='archive unavailable'",
    );
    try {
      await service.end(session.id, 'USER_ENDED');
      expect((await store.get(session.id))!.state).toBe('ended');
      await runtime.tick();
      expect((await RemoteSessionRecord.findByPk(session.id))!.state).toBe('pending');
      expect(await redis.hget('remote:{remote-control}:outbox', session.id)).not.toBeNull();
      expect(errors).toHaveBeenCalledWith('archive', expect.any(Error));
    } finally {
      await db.query('DROP TRIGGER reject_remote_archive');
    }
    now = Math.max(now, Date.now()) + 5001;
    await runtime.tick();
    expect((await RemoteSessionRecord.findByPk(session.id))!.endReason).toBe('USER_ENDED');
    expect(await redis.hget('remote:{remote-control}:outbox', session.id)).toBeNull();
  });
  it('outbox acknowledgement compares the exact read value before deleting', async () => {
    const { session } = await service.request(await input());
    await service.end(session.id, 'USER_ENDED');
    const [entry] = await store.readOutbox();
    const replacement = JSON.stringify({ ...JSON.parse(entry.raw), reason: 'NEWER_EVENT' });
    await redis.hset('remote:{remote-control}:outbox', entry.id, replacement);
    expect(await store.acknowledgeHistory(entry.id, entry.raw)).toBe(false);
    expect(await redis.hget('remote:{remote-control}:outbox', entry.id)).toBe(replacement);
  });
  it('revoking the grant creator sid stops related sessions even when the current host sid differs', async () => {
    const request = await input();
    const { session } = await service.request(request);
    await revokeLoginSession(host.id, creatorLogin.loginSessionId);
    await runtime.revoke({ userId: host.id, sid: creatorLogin.loginSessionId });
    expect((await store.get(session.id))!.reason).toBe('AUTH_REVOKED');
    await runtime.tick();
    expect((await AssistanceGrant.findByPk(request.grantId))!.revokedAt).not.toBeNull();
    expect((await RemoteSessionRecord.findByPk(session.id))!.state).toBe('ended');
  });
  it('account revocation preserves sessions created with the new login version', async () => {
    const { session: old } = await service.request(await input());
    await replacePasswordAndRevokeSessions(controller.id, 'new-password');
    await controller.reload();
    controllerLogin = await createLoginSession(controller.id);
    const { session: fresh } = await service.request(await input());
    await runtime.revoke({
      userId: controller.id,
      revokedAuthVersion: old.controller.authVersion,
      currentAuthVersion: controller.authVersion,
    });
    expect((await store.get(old.id))!.state).toBe('ended');
    expect((await store.get(fresh.id))!.state).toBe('pending');
  });
  it('out-of-order account revocation versions have separate jobs and never revoke a later login', async () => {
    const { session: first } = await service.request(await input());
    await replacePasswordAndRevokeSessions(controller.id, 'second-password');
    await controller.reload();
    controllerLogin = await createLoginSession(controller.id);
    const { session: second } = await service.request(await input());
    await replacePasswordAndRevokeSessions(controller.id, 'third-password');
    await controller.reload();
    controllerLogin = await createLoginSession(controller.id);
    const { session: third } = await service.request(await input());
    const newer = {
      userId: controller.id,
      revokedAuthVersion: second.controller.authVersion,
      currentAuthVersion: controller.authVersion,
    };
    const older = {
      userId: controller.id,
      revokedAuthVersion: first.controller.authVersion,
      currentAuthVersion: second.controller.authVersion,
    };
    // Deliberately enqueue v2 before the late v1 event; neither job can overwrite the other.
    await store.enqueueRevocation(newer);
    await store.enqueueRevocation(older);
    expect(await store.readRevocations(Date.now() + 1000)).toHaveLength(2);
    await runtime.revoke(newer);
    await runtime.revoke(older);
    for (let i = 0; i < 4; i++) await runtime.tick();
    expect((await store.get(first.id))!.reason).toBe('AUTH_REVOKED');
    expect((await store.get(second.id))!.reason).toBe('AUTH_REVOKED');
    expect((await store.get(third.id))!.state).toBe('pending');
  });
  it('Redis loss becomes interrupted with unknown endedAt and cannot restore a historic request', async () => {
    const request = await input();
    const { session } = await service.request(request);
    await RemoteSessionRecord.update(
      { createdAt: new Date(Date.now() - 120_000) },
      { where: { sessionId: session.id } },
    );
    await redis.flushdb();
    await runtime.tick();
    const record = (await RemoteSessionRecord.findByPk(session.id))!;
    expect(record.state).toBe('interrupted');
    expect(record.endedAt).toBeNull();
    const event = await RemoteSessionEvent.findOne({
      where: { sessionId: session.id, eventSeq: -1 },
    });
    expect(event!.occurredAt).toBeNull();
    await expect(service.request(request)).rejects.toThrow('SESSION_ENDED');
    expect(await store.get(session.id)).toBeNull();
  });
  it('Redis errors are not interpreted as lost state', async () => {
    const { session } = await service.request(await input());
    await RemoteSessionRecord.update(
      { createdAt: new Date(Date.now() - 120_000) },
      { where: { sessionId: session.id } },
    );
    vi.spyOn(store, 'get').mockRejectedValueOnce(new Error('Redis unreachable'));
    await runtime.tick();
    expect((await RemoteSessionRecord.findByPk(session.id))!.state).toBe('pending');
    expect(errors).toHaveBeenCalledWith('reconcile', expect.any(Error));
  });
  it('retention deletes only old terminal rows and their events in one transaction', async () => {
    const old = (await service.request(await input())).session;
    const fresh = (await service.request(await input())).session;
    const active = (await service.request(await input())).session;
    const interrupted = (await service.request(await input())).session;
    await redis.del(`remote:{remote-control}:session:${interrupted.id}`);
    await store.cleanupOrphan((await RemoteSessionRecord.findByPk(interrupted.id))!);
    await history.markInterrupted(interrupted.id);
    for (const session of [old, fresh]) {
      const terminal = (await service.end(session.id, 'USER_ENDED'))!;
      await history.archiveEnd(terminal);
      const entry = (await store.readOutbox()).find((item) => item.id === session.id)!;
      await store.acknowledgeHistory(entry.id, entry.raw);
    }
    await db.query(
      'UPDATE remote_sessions SET updatedAt = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 31 DAY) WHERE sessionId IN (:old, :active, :interrupted)',
      { replacements: { old: old.id, active: active.id, interrupted: interrupted.id } },
    );
    const result = await history.pruneTerminal(
      new Date(Date.now() - REMOTE_HISTORY_RETENTION_MS),
      null,
      25,
      (id) => store.canPruneHistory(id),
    );
    expect(result.deleted).toBe(2);
    expect(await RemoteSessionRecord.findByPk(interrupted.id)).toBeNull();
    expect(await RemoteSessionEvent.count({ where: { sessionId: interrupted.id } })).toBe(0);
    expect(await RemoteSessionRecord.findByPk(old.id)).toBeNull();
    expect(await RemoteSessionEvent.count({ where: { sessionId: old.id } })).toBe(0);
    expect(await RemoteSessionRecord.findByPk(fresh.id)).not.toBeNull();
    expect(await RemoteSessionRecord.findByPk(active.id)).not.toBeNull();
  });
  it('unacknowledged outbox protects old history and deletion faults roll events back', async () => {
    const { session } = await service.request(await input());
    const ended = (await service.end(session.id, 'USER_ENDED'))!;
    await history.archiveEnd(ended);
    const [entry] = await store.readOutbox();
    await store.deferHistory(entry.id, entry.raw, Date.now() + 60_000);
    await db.query(
      'UPDATE remote_sessions SET updatedAt = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 31 DAY) WHERE sessionId = :id',
      { replacements: { id: session.id } },
    );
    const cutoff = new Date(Date.now() - REMOTE_HISTORY_RETENTION_MS);
    expect(
      (await history.pruneTerminal(cutoff, null, 25, (id) => store.canPruneHistory(id))).deleted,
    ).toBe(0);
    await store.acknowledgeHistory(entry.id, entry.raw);
    await db.query(
      "CREATE TRIGGER reject_history_delete BEFORE DELETE ON remote_sessions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='retention fault'",
    );
    try {
      await expect(
        history.pruneTerminal(cutoff, null, 25, (id) => store.canPruneHistory(id)),
      ).rejects.toThrow('retention fault');
      expect(await RemoteSessionRecord.findByPk(session.id)).not.toBeNull();
      expect(await RemoteSessionEvent.count({ where: { sessionId: session.id } })).toBe(2);
    } finally {
      await db.query('DROP TRIGGER reject_history_delete');
    }
    await expect(
      history.pruneTerminal(cutoff, null, 25, async () => {
        throw new Error('Redis unavailable');
      }),
    ).rejects.toThrow();
    expect(await RemoteSessionRecord.findByPk(session.id)).not.toBeNull();
  });
  it('failed archival keeps an old interrupted history row protected by its deferred outbox', async () => {
    const { session } = await service.request(await input());
    await service.end(session.id, 'USER_ENDED');
    // Simulate the terminal tombstone expiring while SQL archival remains unavailable.
    await redis.del(`remote:{remote-control}:session:${session.id}`);
    await history.markInterrupted(session.id);
    await db.query(
      'UPDATE remote_sessions SET updatedAt = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 31 DAY) WHERE sessionId = :id',
      { replacements: { id: session.id } },
    );
    await db.query(
      "CREATE TRIGGER reject_old_archive BEFORE UPDATE ON remote_sessions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='archive unavailable'",
    );
    try {
      await runtime.tick();
      expect((await RemoteSessionRecord.findByPk(session.id))!.state).toBe('interrupted');
      expect(await RemoteSessionEvent.count({ where: { sessionId: session.id } })).toBe(2);
      expect(await redis.hget('remote:{remote-control}:outbox', session.id)).not.toBeNull();
      expect(errors).toHaveBeenCalledWith('archive', expect.any(Error));
    } finally {
      await db.query('DROP TRIGGER reject_old_archive');
    }
    now = Math.max(now, Date.now()) + 5001;
    await runtime.tick();
    expect((await RemoteSessionRecord.findByPk(session.id))!.state).toBe('ended');
    expect(await redis.hget('remote:{remote-control}:outbox', session.id)).toBeNull();
  });
  it('retention scans bounded batches past protected records and waits an hour after draining', async () => {
    const sessions = [];
    for (let i = 0; i < 3; i++) sessions.push((await service.request(await input())).session);
    sessions.sort((a, b) => a.id.localeCompare(b.id));
    for (const session of sessions) {
      await history.archiveEnd((await service.end(session.id, 'USER_ENDED'))!);
      const entry = (await store.readOutbox()).find((value) => value.id === session.id)!;
      if (session.id === sessions[0].id)
        await store.deferHistory(entry.id, entry.raw, Date.now() + 7_200_000);
      else await store.acknowledgeHistory(entry.id, entry.raw);
    }
    await db.query(
      'UPDATE remote_sessions SET updatedAt = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 31 DAY)',
    );
    const prune = vi.spyOn(history, 'pruneTerminal');
    await runtime.tick();
    expect(await RemoteSessionRecord.count()).toBe(2);
    await runtime.tick();
    expect(await RemoteSessionRecord.count()).toBe(1);
    expect(await RemoteSessionRecord.findByPk(sessions[0].id)).not.toBeNull();
    await runtime.tick();
    expect(prune).toHaveBeenCalledTimes(2);
  });
  it('startup ends prior-process sessions before allowing any new admission', async () => {
    const { session } = await service.request(await input());
    const nextRequest = await input();
    const restarted = new RemoteControlRuntime(service, store, history, {
      intervalMs: 10000,
      reportError: errors,
    });
    restarted.start();
    try {
      await expect(service.request(nextRequest)).rejects.toThrow('RUNTIME_RECOVERING');
      await restarted.tick();
      expect((await store.get(session.id))!.reason).toBe('SERVER_RESTART');
      await expect(service.request(nextRequest)).resolves.toHaveProperty('created', true);
    } finally {
      await restarted.stop();
    }
  });
  it('shutdown cancels an admission still waiting for its durable request write', async () => {
    const request = await input();
    const prepare = history.prepareRequest.bind(history);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(history, 'prepareRequest').mockImplementation(async (session) => {
      const result = await prepare(session);
      await waiting;
      return result;
    });
    const admitted = service.request(request);
    await runtime.stop();
    release();
    await expect(admitted).rejects.toThrow('REMOTE_SHUTTING_DOWN');
    expect(await redis.keys('remote:*occupied:*')).toHaveLength(0);
  });
  it('stop removes subscriptions, ends active sessions, and is idempotent', async () => {
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    const scheduled = new RemoteControlRuntime(service, store, history, {
      subscribe,
      intervalMs: 10000,
      reportError: errors,
    });
    scheduled.start();
    await scheduled.tick();
    const { session } = await service.request(await input());
    const stop = scheduled.stop();
    expect(scheduled.stop()).toBe(stop);
    await stop;
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect((await store.get(session.id))!.reason).toBe('SERVER_SHUTDOWN');
    expect((await RemoteSessionRecord.findByPk(session.id))!.state).toBe('ended');
  });
});

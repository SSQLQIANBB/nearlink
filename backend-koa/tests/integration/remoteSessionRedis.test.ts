import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { RedisRemoteSessionStore } from '../../src/services/redisRemoteSessionStore';
import { RemoteControlService } from '../../src/services/remoteControlService';
import { RemoteDeviceChallengeStore } from '../../src/services/remoteDeviceProof';
import type { RemoteHistoryWriter } from '../../src/services/remoteSessionHistory';
import { RemoteControlError } from '../../src/services/remoteControlProtocol';
import type { RemoteEndpoint } from '../../src/services/remoteControlProtocol';

let directory: string, processHandle: ChildProcess, redis: Redis;
let store: RedisRemoteSessionStore, service: RemoteControlService;
let now = Date.now();
const controller: RemoteEndpoint = { userId: 1, sid: 'sid1', authVersion: 'v1', endpointId: 'controller', connectionId: 'sock1', generation: 1 };
const host: RemoteEndpoint = { userId: 2, sid: 'sid2', authVersion: 'v2', endpointId: 'host', connectionId: 'sock2', generation: 1 };
const request = () => ({ requestId: randomUUID(), grantId: randomUUID(), controller, host, scope: 'control' as const });

const prepared = new Map<string, { id: string; hash: string }>();
// This suite isolates Redis CAS; the runtime suite below exercises the real SQL writer.
const history: RemoteHistoryWriter = {
  async prepareRequest(session) {
    const key = `${session.controller.sid}:${session.requestId}`;
    const prior = prepared.get(key);
    if (prior && prior.hash !== session.requestHash) throw new RemoteControlError('IDEMPOTENCY_CONFLICT');
    if (!prior) prepared.set(key, { id: session.id, hash: session.requestHash });
    return { created: !prior, sessionId: prior?.id || session.id, state: 'pending' };
  },
  async assertAuthorized() {}, async archiveEnd() {},
};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'td-rc-'));
  const socket = join(directory, 'redis.sock');
  processHandle = spawn(process.env.REDIS_TEST_BINARY || 'redis-server', [
    '--port', '0', '--unixsocket', socket, '--unixsocketperm', '700', '--save', '', '--appendonly', 'no', '--dir', directory,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Isolated Redis did not start')), 10_000);
    processHandle.once('error', error => { clearTimeout(timeout); reject(error); });
    processHandle.once('exit', code => { clearTimeout(timeout); reject(new Error(`Redis exited ${code}`)); });
    processHandle.stdout!.on('data', chunk => {
      if (String(chunk).includes('ready to accept connections') || String(chunk).includes('Ready to accept connections')) { clearTimeout(timeout); resolve(); }
    });
  });
  redis = new Redis(socket, { maxRetriesPerRequest: 1, retryStrategy: () => null });
  await redis.ping();
  store = new RedisRemoteSessionStore(redis);
  service = new RemoteControlService(store, () => now, history);
});
beforeEach(async () => { now = Date.now(); prepared.clear(); await redis.flushdb(); });
afterAll(async () => {
  if (redis) { await redis.quit(); }
  if (processHandle?.exitCode === null) {
    const exited = new Promise<void>(resolve => processHandle.once('exit', () => resolve()));
    processHandle.kill('SIGTERM'); await exited;
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('真实Redis远控竞争与隔离（独立Unix socket，不访问应用Redis）', () => {
  it('识别挑战按账号、登录会话及用途隔离，只能消费一次', async () => {
    const challenges = new RemoteDeviceChallengeStore(redis);
    const challenge = await challenges.create(1, 'sid1', 'identify-device');
    await expect(challenges.consume(challenge.id, 2, 'sid1', 'identify-device')).rejects.toThrow();
    await expect(challenges.consume(challenge.id, 1, 'sid2', 'identify-device')).rejects.toThrow();
    await expect(challenges.consume(challenge.id, 1, 'sid1', 'register-device')).rejects.toThrow();
    expect(await challenges.consume(challenge.id, 1, 'sid1', 'identify-device')).toEqual(challenge);
    await expect(challenges.consume(challenge.id, 1, 'sid1', 'identify-device')).rejects.toThrow();
  });
  it('两个主控并发请求只允许一个占用目标设备', async () => {
    const attempts = await Promise.allSettled([
      service.request(request()),
      service.request({ ...request(), controller: { ...controller, sid: 'sid3', endpointId: 'third', connectionId: 'sock3' } }),
    ]);
    expect(attempts.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(x => x.status === 'rejected')).toHaveLength(1);
  });
  it('重复创建幂等，同requestId变更payload不伪装成重试', async () => {
    const input = request();
    const first = await service.request(input);
    const retry = await service.request(input);
    expect(retry.created).toBe(false);
    expect(retry.session.id).toBe(first.session.id);
    await expect(service.request({ ...input, scope: 'view' })).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  });
  it('接受与取消CAS只提交一个，结束后的旧保存不会删除新会话占用', async () => {
    const { session } = await service.request(request());
    const results = await Promise.allSettled([
      service.act(session.id, host, 0, { type: 'respond', accepted: true, scope: 'control' }),
      service.act(session.id, controller, 0, { type: 'cancel' }),
    ]);
    expect(results.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    await service.end(session.id, 'TEST_END');
    const next = await service.request(request());
    await expect(store.save(session, { ...session, revision: 1, state: 'ended' }, now)).rejects.toThrow();
    await expect(service.request(request())).rejects.toThrow('ENDPOINT_BUSY');
    expect((await store.get(next.session.id))?.state).toBe('pending');
  });
  it('过期接受写入终态/outbox并释放双方，而非恢复控制', async () => {
    const { session } = await service.request(request());
    now = session.deadline;
    expect(await store.due(now)).toContain(session.id);
    const expired = await service.act(session.id, host, 0, { type: 'respond', accepted: true, scope: 'control' });
    expect(expired.state).toBe('ended');
    expect(await store.due(now)).not.toContain(session.id);
    expect(JSON.parse((await store.outbox())[session.id]).reason).toBe('EXPIRED');
    await service.request(request());
  });
  it('通过应用检查后在Redis提交前过期的接受仍必须终止', async () => {
    const { session } = await service.request(request());
    const nearExpiry = { ...session, deadline: Date.now() + 30 };
    await redis.set(`remote:{remote-control}:session:${session.id}`, JSON.stringify(nearExpiry));
    const delayed = new RemoteControlService({
      get: id => store.get(id), create: value => store.create(value),
      save: async (previous, next, clock) => {
        if (next.state !== 'ended') await new Promise(resolve => setTimeout(resolve, 60));
        return store.save(previous, next, clock);
      },
    }, () => now, history);
    const ended = await delayed.act(session.id, host, 0, { type: 'respond', accepted: true, scope: 'control' });
    expect(ended.state).toBe('ended');
    expect(ended.reason).toBe('EXPIRED');
    await service.request(request());
  });
  it('原生挑战错误账号不能消费，正确账号并发只能成功消费一次', async () => {
    const proofs = new RemoteDeviceChallengeStore(redis, () => now);
    const challenge = await proofs.create(1, 'sid1');
    await expect(proofs.consume(challenge.id, 2, 'sid1')).rejects.toThrow();
    const results = await Promise.allSettled([proofs.consume(challenge.id, 1, 'sid1'), proofs.consume(challenge.id, 1, 'sid1')]);
    expect(results.filter(x => x.status === 'fulfilled')).toHaveLength(1);
  });
});

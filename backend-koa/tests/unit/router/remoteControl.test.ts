import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Koa from 'koa';
import { koaBody } from 'koa-body';
import { createServer, type Server } from 'http';
import { Op } from 'sequelize';
import { generateKeyPairSync, randomUUID } from 'crypto';

const mocks = vi.hoisted(() => ({
  validate: vi.fn(),
  sessions: vi.fn(),
  redisGet: vi.fn(),
  redisEval: vi.fn(),
  redisSet: vi.fn(),
  authority: vi.fn(),
  grants: vi.fn(),
  createGrant: vi.fn(),
  user: vi.fn(),
}));
vi.mock('../../../src/config/redis', () => ({
  default: { get: mocks.redisGet, eval: mocks.redisEval, set: mocks.redisSet },
}));
vi.mock('../../../src/services/loginSessionService', () => ({
  validateAuthenticatedSession: mocks.validate,
}));
vi.mock('../../../src/models/RemoteControl', () => ({
  RemoteDevice: {},
  RemoteSessionRecord: { findAll: mocks.sessions },
  AssistanceGrant: {
    findAll: mocks.grants,
    create: mocks.createGrant,
    sequelize: { transaction: async (action: any) => action({ LOCK: { UPDATE: true } }) },
  },
}));
vi.mock('../../../src/services/remoteSessionHistory', () => ({
  RemoteSessionHistory: class {
    assertAuthorized = mocks.authority;
  },
}));
vi.mock('../../../src/models/User', () => ({ default: { findByPk: mocks.user } }));
import remoteRouter from '../../../src/router/remoteControl';
import cors from '../../../src/middleware/cors';
let server: Server, origin: string;
beforeAll(async () => {
  const app = new Koa();
  app.use(cors);
  app.use(koaBody());
  app.use(remoteRouter.routes()).use(remoteRouter.allowedMethods());
  server = createServer(app.callback());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.redisGet.mockResolvedValue(null);
  mocks.grants.mockResolvedValue([]);
  mocks.user.mockResolvedValue({ id: 8 });
  mocks.createGrant.mockImplementation(async (value) => value);
  mocks.authority.mockResolvedValue(undefined);
  mocks.validate.mockResolvedValue({ userId: 7, sid: 'session-7' });
  mocks.sessions.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());
const read = (path: string, token = 'valid') =>
  fetch(`${origin}/api/remote-control${path}`, { headers: { Authorization: `Bearer ${token}` } });

describe('远控REST真实HTTP权限边界', () => {
  it('旧联系人许可创建入口不再提供', async () => {
    const response = await fetch(`${origin}/api/remote-control/assistance-grants`, {
      method: 'POST', headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostDeviceId: randomUUID(), controllerUserId: 8, duration: 'permanent' }),
    });
    expect([404, 405]).toContain(response.status);
  });
  it('签名公钥接口要求登录，只返回显式配置的公钥与有效期', async () => {
    expect((await fetch(`${origin}/api/remote-control/signing-keys`)).status).toBe(401);
    const pair = generateKeyPairSync('ed25519');
    const now = Date.now();
    vi.stubEnv('REMOTE_CONTROL_SIGNING_KEY_ID', 'deployment-test');
    vi.stubEnv(
      'REMOTE_CONTROL_SIGNING_PRIVATE_KEY',
      pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    );
    vi.stubEnv('REMOTE_CONTROL_SIGNING_KEY_NOT_BEFORE', String(now));
    vi.stubEnv('REMOTE_CONTROL_SIGNING_KEY_NOT_AFTER', String(now + 60000));
    const response = await read('/signing-keys');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      keys: [
        {
          keyId: 'deployment-test',
          publicKey: pair.publicKey.export({ format: 'jwk' }).x,
          notBefore: now,
          notAfter: now + 60000,
        },
      ],
    });
  });
  it('缺少登录或已撤销sid不可读取会话', async () => {
    expect((await fetch(`${origin}/api/remote-control/sessions`)).status).toBe(401);
    mocks.validate.mockRejectedValue(new Error('revoked'));
    expect((await read('/sessions')).status).toBe(401);
    expect(mocks.sessions).not.toHaveBeenCalled();
  });
  it('历史查询绑定当前账号', async () => {
    await read('/sessions');
    expect(mocks.sessions.mock.calls[0][0].where[Op.or]).toEqual([
      { controllerUserId: 7 },
      { hostUserId: 7 },
    ]);
  });
  it('未验收时不返回聊天在线用户为远控目标，不向任意会话发放ICE凭据', async () => {
    expect((await read('/targets?userId=8')).status).toBe(404);
    const ice = await read('/sessions/00000000-0000-4000-8000-000000000000/ice');
    expect(ice.status).toBe(404);
    expect((await ice.json()).code).toBe('SESSION_NOT_FOUND');
    expect(ice.headers.get('cache-control')).toBe('no-store');
    expect((await read('/sessions/not-a-uuid/ice')).status).toBe(400);
    expect(
      (
        await fetch(
          `${origin}/api/remote-control/sessions/00000000-0000-4000-8000-000000000000/ice`,
        )
      ).status,
    ).toBe(401);
  });
  it('ICE真实HTTP响应无缓存，只有绑定登录能获取带签名的临时凭据，未配置返回明确503', async () => {
    const now = Date.now(),
      pair = generateKeyPairSync('ed25519');
    const endpoint = (userId: number) => ({
      userId,
      sid: randomUUID(),
      authVersion: randomUUID(),
      endpointId: randomUUID(),
      connectionId: randomUUID(),
      generation: 1,
    });
    const session = {
      id: randomUUID(),
      host: endpoint(7),
      controller: endpoint(8),
      state: 'connecting',
      revision: 2,
      authorizationRevision: 1,
      deadline: now + 30000,
      hardDeadline: now + 3600000,
    };
    mocks.redisGet.mockResolvedValue(JSON.stringify(session));
    mocks.validate.mockResolvedValue(session.host);
    vi.stubEnv('REMOTE_TURN_SHARED_SECRET', 'test-only-secret'.repeat(4));
    vi.stubEnv('REMOTE_CONTROL_SIGNING_KEY_ID', 'deployment-test');
    vi.stubEnv(
      'REMOTE_CONTROL_SIGNING_PRIVATE_KEY',
      pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    );
    vi.stubEnv('REMOTE_CONTROL_SIGNING_KEY_NOT_BEFORE', String(now - 1));
    vi.stubEnv('REMOTE_CONTROL_SIGNING_KEY_NOT_AFTER', String(now + 4000000));
    const response = await read(`/sessions/${session.id}/ice`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.proof.format).toBe('rc-signed-v1');
    expect(body.iceServers[1].username).toMatch(/^[0-9]+:rc:[a-f0-9]{32}$/);
    expect(body.iceServers[1].credential).toMatch(/^[A-Za-z0-9+/]{27}=$/);
    expect(mocks.authority).toHaveBeenCalledWith(session);
    mocks.validate.mockResolvedValue({ ...session.host, sid: randomUUID() });
    expect((await read(`/sessions/${session.id}/ice`)).status).toBe(403);
    mocks.validate.mockResolvedValue(session.host);
    vi.stubEnv('REMOTE_TURN_SHARED_SECRET', '');
    const missing = await read(`/sessions/${session.id}/ice`);
    expect(missing.status).toBe(503);
    expect((await missing.json()).code).toBe('REMOTE_ICE_UNCONFIGURED');
  });
});

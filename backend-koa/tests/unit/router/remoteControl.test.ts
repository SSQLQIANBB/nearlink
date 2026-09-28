import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Koa from 'koa';
import { koaBody } from 'koa-body';
import { createServer, type Server } from 'http';
import { Op } from 'sequelize';
import { generateKeyPairSync, randomUUID, randomBytes, sign, createHash } from 'crypto';

const mocks = vi.hoisted(() => ({ validate: vi.fn(), devices: vi.fn(), rename: vi.fn(), sessions: vi.fn(), revoke: vi.fn(), redisGet: vi.fn(), redisEval: vi.fn(), redisSet: vi.fn(), authority: vi.fn(), grants: vi.fn(), createGrant: vi.fn(), user: vi.fn() }));
vi.mock('../../../src/config/redis', () => ({ default: { get: mocks.redisGet, eval: mocks.redisEval, set: mocks.redisSet } }));
vi.mock('../../../src/services/loginSessionService', () => ({ validateAuthenticatedSession: mocks.validate }));
vi.mock('../../../src/models/RemoteControl', () => ({
  RemoteDevice: { findAll: mocks.devices, findOne: mocks.revoke, update: mocks.rename },
  RemoteSessionRecord: { findAll: mocks.sessions }, AssistanceGrant: { findAll: mocks.grants, create: mocks.createGrant, sequelize: { transaction: async (action: any) => action({ LOCK: { UPDATE: true } }) } },
}));
vi.mock('../../../src/services/remoteSessionHistory', () => ({ RemoteSessionHistory: class { assertAuthorized = mocks.authority; } }));
vi.mock('../../../src/models/User', () => ({ default: { findByPk: mocks.user } }));
import { canonicalJson } from '../../../src/services/remoteControlProtocol';
import remoteRouter from '../../../src/router/remoteControl';
import cors from '../../../src/middleware/cors';
let server: Server, origin: string;
beforeAll(async () => {
  const app = new Koa(); app.use(cors); app.use(koaBody()); app.use(remoteRouter.routes()).use(remoteRouter.allowedMethods());
  server = createServer(app.callback());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.redisGet.mockResolvedValue(null); mocks.grants.mockResolvedValue([]); mocks.user.mockResolvedValue({ id: 8 }); mocks.createGrant.mockImplementation(async value => value);
  mocks.authority.mockResolvedValue(undefined);
  mocks.validate.mockResolvedValue({ userId: 7, sid: 'session-7' });
  mocks.devices.mockResolvedValue([]); mocks.sessions.mockResolvedValue([]); mocks.revoke.mockResolvedValue(null);
});
afterEach(() => vi.unstubAllEnvs());
const read = (path: string, token = 'valid') => fetch(`${origin}/api/remote-control${path}`, { headers: { Authorization: `Bearer ${token}` } });

describe('远控REST真实HTTP权限边界', () => {
  it('协助许可支持临时/长期，续期保持ID并拒绝任意时长', async () => {
    vi.stubEnv('REMOTE_CONTROL_PREVIEW_USER_IDS', '7');
    const id = randomUUID(); mocks.revoke.mockResolvedValue({ id });
    const grant = (duration?: string) => fetch(`${origin}/api/remote-control/assistance-grants`, {
      method: 'POST', headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostDeviceId: id, controllerUserId: 8, ...(duration ? { duration } : {}) }),
    });
    const before = Date.now();
    const temporary = await (await grant()).json();
    expect(new Date(temporary.grant.expiresAt).getTime() - before).toBeGreaterThanOrEqual(900000);
    const hour = await (await grant('1h')).json();
    expect(new Date(hour.grant.expiresAt).getTime() - before).toBeGreaterThanOrEqual(3600000);
    expect((await (await grant('permanent')).json()).grant.expiresAt).toBeNull();
    const prior = { id: randomUUID(), hostDeviceId: id, controllerUserId: 8, createdBySid: 'session-7', expiresAt: null as Date | null,
      update: vi.fn(async function(this: any, values: any) { Object.assign(this, values); }) };
    mocks.grants.mockResolvedValue([prior]);
    expect((await (await grant('1h')).json()).grant.id).toBe(prior.id);
    expect(prior.expiresAt).toBeInstanceOf(Date);
    expect((await grant('forever-invalid')).status).toBe(400);
    mocks.revoke.mockResolvedValue(null);
    expect((await grant('permanent')).status).toBe(404);
  });
  it('签名公钥接口要求登录，只返回显式配置的公钥与有效期', async () => {
    expect((await fetch(`${origin}/api/remote-control/signing-keys`)).status).toBe(401);
    const pair = generateKeyPairSync('ed25519');
    const now = Date.now();
    vi.stubEnv('REMOTE_CONTROL_SIGNING_KEY_ID', 'deployment-test');
    vi.stubEnv('REMOTE_CONTROL_SIGNING_PRIVATE_KEY', pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    vi.stubEnv('REMOTE_CONTROL_SIGNING_KEY_NOT_BEFORE', String(now));
    vi.stubEnv('REMOTE_CONTROL_SIGNING_KEY_NOT_AFTER', String(now + 60000));
    const response = await read('/signing-keys');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ keys: [{ keyId: 'deployment-test', publicKey: pair.publicKey.export({ format: 'jwk' }).x,
      notBefore: now, notAfter: now + 60000 }] });
  });
  it('缺少登录或已撤销sid不可读取设备/会话', async () => {
    expect((await fetch(`${origin}/api/remote-control/devices`)).status).toBe(401);
    mocks.validate.mockRejectedValue(new Error('revoked'));
    expect((await read('/sessions')).status).toBe(401);
    expect(mocks.sessions).not.toHaveBeenCalled();
  });
  it('设备与历史查询绑定当前账号，输出不包含设备密钥或登录sid', async () => {
    mocks.devices.mockResolvedValue([{ id: 'device', alias: 'Mac', platform: 'macos', publicKey: 'secret-key-metadata', fingerprint: 'fingerprint', ownerUserId: 7 }]);
    const devices = await (await read('/devices')).json();
    expect(mocks.devices.mock.calls[0][0].where).toEqual({ ownerUserId: 7 });
    expect(devices.devices[0]).toEqual({ deviceId: 'device', alias: 'Mac', platform: 'macos' });
    await read('/sessions');
    expect(mocks.sessions.mock.calls[0][0].where[Op.or]).toEqual([{ controllerUserId: 7 }, { hostUserId: 7 }]);
  });
  it('未验收时不返回聊天在线用户为远控目标，不向任意会话发放ICE凭据', async () => {
    expect(await (await read('/targets?userId=8')).json()).toEqual({ targets: [] });
    const ice = await read('/sessions/00000000-0000-4000-8000-000000000000/ice');
    expect(ice.status).toBe(404);
    expect((await ice.json()).code).toBe('SESSION_NOT_FOUND');
    expect(ice.headers.get('cache-control')).toBe('no-store');
    expect((await read('/sessions/not-a-uuid/ice')).status).toBe(400);
    expect((await fetch(`${origin}/api/remote-control/sessions/00000000-0000-4000-8000-000000000000/ice`)).status).toBe(401);
  });
  it('ICE真实HTTP响应无缓存，只有绑定登录能获取带签名的临时凭据，未配置返回明确503', async () => {
    const now = Date.now(), pair = generateKeyPairSync('ed25519');
    const endpoint = (userId: number) => ({ userId, sid: randomUUID(), authVersion: randomUUID(), endpointId: randomUUID(), connectionId: randomUUID(), generation: 1 });
    const session = { id: randomUUID(), host: endpoint(7), controller: endpoint(8), state: 'connecting', revision: 2,
      authorizationRevision: 1, deadline: now + 30000, hardDeadline: now + 3600000 };
    mocks.redisGet.mockResolvedValue(JSON.stringify(session));
    mocks.validate.mockResolvedValue(session.host);
    vi.stubEnv('REMOTE_TURN_SHARED_SECRET', 'test-only-secret'.repeat(4));
    vi.stubEnv('REMOTE_CONTROL_SIGNING_KEY_ID', 'deployment-test');
    vi.stubEnv('REMOTE_CONTROL_SIGNING_PRIVATE_KEY', pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    vi.stubEnv('REMOTE_CONTROL_SIGNING_KEY_NOT_BEFORE', String(now - 1));
    vi.stubEnv('REMOTE_CONTROL_SIGNING_KEY_NOT_AFTER', String(now + 4000000));
    const response = await read(`/sessions/${session.id}/ice`);
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.proof.format).toBe('rc-signed-v1');
    expect(body.iceServers[1].username).toMatch(/^[0-9]+:rc:[a-f0-9]{32}$/);
    expect(body.iceServers[1].credential).toMatch(/^[A-Za-z0-9+/]{27}=$/);
    expect(mocks.authority).toHaveBeenCalledWith(session);
    mocks.validate.mockResolvedValue({ ...session.host, sid: randomUUID() });
    expect((await read(`/sessions/${session.id}/ice`)).status).toBe(403);
    mocks.validate.mockResolvedValue(session.host); vi.stubEnv('REMOTE_TURN_SHARED_SECRET', '');
    const missing = await read(`/sessions/${session.id}/ice`);
    expect(missing.status).toBe(503); expect((await missing.json()).code).toBe('REMOTE_ICE_UNCONFIGURED');
  });
  it('不能通过删除其他账号设备枚举其存在状态', async () => {
    const response = await fetch(`${origin}/api/remote-control/devices/00000000-0000-4000-8000-000000000000`, {
      method: 'DELETE', headers: { Authorization: 'Bearer valid' },
    });
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe('TARGET_UNAVAILABLE');
    expect(mocks.revoke.mock.calls[0][0].where.ownerUserId).toBe(7);
  });
});

describe('设备名称修改', () => {
  it('跨域预检允许带认证的 PATCH', async () => {
    const response = await fetch(`${origin}/api/remote-control/devices/${randomUUID()}`, {
      method: 'OPTIONS', headers: { Origin: 'http://localhost:1420', 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'authorization,content-type' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('PATCH');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });
  const patch = (id: string, body: unknown) => fetch(`${origin}/api/remote-control/devices/${id}`, {
    method: 'PATCH', headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  it('仅更新当前账号的有效设备并返回安全字段，同名更新也成功', async () => {
    const id = randomUUID();
    mocks.rename.mockResolvedValue([0]);
    mocks.revoke.mockResolvedValue({ id, alias: '办公 Mac', platform: 'macos', revokedAt: null, publicKey: 'not-public', ownerUserId: 7 });
    const response = await patch(id, { alias: ' 办公 Mac ' });
    expect(response.status).toBe(200);
    expect(mocks.rename).toHaveBeenCalledWith({ alias: '办公 Mac' }, { where: { id, ownerUserId: 7, revokedAt: null } });
    const result = await response.json();
    expect(result.device.alias).toBe('办公 Mac'); expect(result.device).not.toHaveProperty('publicKey');
  });
  it('其他账号、已撤销或不存在的设备统一不可用', async () => {
    mocks.rename.mockResolvedValue([0]); mocks.revoke.mockResolvedValue(null);
    expect((await patch(randomUUID(), { alias: '名称' })).status).toBe(404);
    expect(mocks.revoke).toHaveBeenCalledWith({ where: { id: expect.any(String), ownerUserId: 7, revokedAt: null } });
  });
  it.each([{ alias: ' ' }, { alias: 'a'.repeat(81) }, { alias: 'a\u0000b' }, { alias: 3 }, { alias: '名称', ownerUserId: 8 }])('拒绝无效名称和额外字段 %j', async body => {
    expect((await patch(randomUUID(), body)).status).toBe(400); expect(mocks.rename).not.toHaveBeenCalled();
  });
});

describe('本机识别 HTTP', () => {
  it('验证签名后仅查询本人有效登记；不会登记或授予权限', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const sid = randomUUID(); mocks.validate.mockResolvedValue({ userId: 7, sid });
    const challenge = { id: randomUUID(), nonce: randomBytes(32).toString('base64url'), userId: 7, sid, action: 'identify-device', expiresAt: Date.now() + 30000 };
    const pem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const signature = sign(null, Buffer.from(canonicalJson({ protocolVersion: 1, ...challenge, publicKey: pem, platform: 'macos' })), privateKey).toString('base64');
    mocks.redisEval.mockResolvedValue(JSON.stringify(challenge));
    const id = randomUUID(); mocks.revoke.mockResolvedValue({ id, alias: '本机', platform: 'macos', revokedAt: null, publicKey: pem });
    const submit = () => fetch(`${origin}/api/remote-control/device-identity/verify`, { method: 'POST', headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' }, body: JSON.stringify({ challengeId: challenge.id, publicKey: pem, platform: 'macos', signature }) });
    const response = await submit(); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ device: { deviceId: id, alias: '本机', platform: 'macos', revokedAt: null } });
    expect(mocks.revoke).toHaveBeenCalledWith({ where: { ownerUserId: 7, revokedAt: null, platform: 'macos', fingerprint: createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex') } });
    expect(mocks.createGrant).not.toHaveBeenCalled();
    mocks.revoke.mockResolvedValue(null); expect((await submit()).status).toBe(404);
  });
  it('挑战接口限流并拒绝额外字段', async () => {
    const submit = (body: unknown) => fetch(`${origin}/api/remote-control/device-identity-challenges`, { method: 'POST', headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    mocks.redisEval.mockResolvedValue(6); expect((await submit({})).status).toBe(429);
    expect((await submit({ userId: 8 })).status).toBe(400); expect(mocks.redisSet).not.toHaveBeenCalled();
  });
});

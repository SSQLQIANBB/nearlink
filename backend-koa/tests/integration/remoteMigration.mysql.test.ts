import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';

const testUrl = process.env.AUTH_TEST_MYSQL_URL;
if (testUrl && !/^todesk_auth_test_[a-zA-Z0-9_]+$/.test(new URL(testUrl).pathname.slice(1))) {
  throw new Error('AUTH_TEST_MYSQL_URL must name a disposable todesk_auth_test_* database');
}
vi.mock('../../src/config/database', async () => {
  const { Sequelize } = await import('sequelize');
  return {
    default: new Sequelize(
      process.env.AUTH_TEST_MYSQL_URL || 'mysql://root@127.0.0.1/todesk_auth_test_disabled',
      { logging: false, dialectOptions: { multipleStatements: true } },
    ),
  };
});
import db from '../../src/config/database';
import { ensureRemoteDeviceCode } from '../../src/services/remoteDeviceCodeRegistry';
import type { RemoteEndpoint } from '../../src/services/remoteControlProtocol';
import {
  RemoteDevice,
  AssistanceGrant,
  RemoteSessionRecord,
  RemoteSessionEvent,
} from '../../src/models/RemoteControl';

const suite = testUrl ? describe : describe.skip;
suite('remote-control migration (real MySQL)', () => {
  const apply = async (name: string) => {
    const sql = readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
    await db.query(sql);
  };
  beforeAll(() => db.authenticate());
  afterAll(async () => {
    await RemoteSessionEvent.drop();
    await RemoteSessionRecord.drop();
    await AssistanceGrant.drop();
    await RemoteDevice.drop();
    await db.close();
  });
  it('reapplies idempotently, matches ORM fields and retains revocations/history on rollback', async () => {
    await apply('20260925-remote-control.up.sql');
    await apply('20260926-remote-lifecycle.up.sql');
    await apply('20261016-remote-device-code.up.sql');
    const device = await RemoteDevice.create({
      id: randomUUID(),
      ownerUserId: 7,
      publicKey: 'test-public-key',
      fingerprint: 'a'.repeat(64),
      alias: '测试 Mac',
      platform: 'macos',
    });
    expect(device.keyVersion).toBe(1);
    expect(device.revokedAt).toBeNull();
    const endpoint = { endpointId: device.id, userId: 7 } as RemoteEndpoint;
    const [code, concurrentCode] = await Promise.all([
      ensureRemoteDeviceCode(endpoint),
      ensureRemoteDeviceCode(endpoint),
    ]);
    expect(code).toMatch(/^\d{9}$/);
    expect(concurrentCode).toBe(code);
    expect((await RemoteDevice.findByPk(device.id))!.deviceCode).toBe(code);
    expect(await ensureRemoteDeviceCode({ ...endpoint, connectionId: 'restarted' })).toBe(code);
    const sid = randomUUID();
    const grant = await AssistanceGrant.create({
      id: randomUUID(),
      hostDeviceId: device.id,
      createdBySid: sid,
      controllerUserId: 8,
      expiresAt: new Date(Date.now() + 600_000),
    });
    const record = await RemoteSessionRecord.create({
      sessionId: randomUUID(),
      controllerUserId: 8,
      hostUserId: 7,
      controllerSid: randomUUID(),
      hostSid: sid,
      hostDeviceId: device.id,
      grantId: grant.id,
      scope: 'view',
      state: 'ended',
      revision: 3,
      endedAt: new Date(),
      endReason: 'USER_ENDED',
    });
    await device.update({ revokedAt: new Date() });
    await apply('20260925-remote-control.up.sql');
    await apply('20260925-remote-control.rollback.sql');
    expect((await RemoteDevice.findByPk(device.id))!.revokedAt).not.toBeNull();
    expect((await AssistanceGrant.findByPk(grant.id))!.createdBySid).toBe(sid);
    expect((await RemoteSessionRecord.findByPk(record.sessionId))!.endReason).toBe('USER_ENDED');
    const indexRows = (await db.getQueryInterface().showIndex('remote_sessions')) as {
      fields: { attribute: string }[];
    }[];
    expect(
      indexRows.some(
        (index) => index.fields.map((field) => field.attribute).join(',') === 'controllerSid',
      ),
    ).toBe(true);
    await expect(
      RemoteDevice.create({
        id: randomUUID(),
        ownerUserId: 9,
        publicKey: 'other-key',
        fingerprint: device.fingerprint,
        alias: '重复设备密钥',
        platform: 'windows',
      }),
    ).rejects.toThrow();
  });
});

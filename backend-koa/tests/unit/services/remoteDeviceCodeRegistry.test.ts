import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UniqueConstraintError } from 'sequelize';
const database = vi.hoisted(() => ({ findOne: vi.fn(), update: vi.fn() }));
vi.mock('../../../src/models/RemoteControl', () => ({ RemoteDevice: database }));
import { ensureRemoteDeviceCode } from '../../../src/services/remoteDeviceCodeRegistry';
import type { RemoteEndpoint } from '../../../src/services/remoteControlProtocol';

const host = { endpointId: 'device', userId: 1 } as RemoteEndpoint;
beforeEach(() => vi.resetAllMocks());
describe('persistent device codes', () => {
  it('reuses the persisted code across sockets and process restarts', async () => {
    database.findOne.mockResolvedValue({ deviceCode: '848219524' });
    expect(await ensureRemoteDeviceCode(host)).toBe('848219524');
    expect(await ensureRemoteDeviceCode({ ...host, connectionId: 'new-socket' })).toBe('848219524');
    expect(database.update).not.toHaveBeenCalled();
  });
  it('assigns once and reads the winner of a concurrent first connection', async () => {
    database.findOne.mockResolvedValueOnce({ deviceCode: null }).mockResolvedValueOnce({ deviceCode: '123456789' });
    database.update.mockResolvedValue([0]);
    expect(await ensureRemoteDeviceCode(host)).toBe('123456789');
    expect(database.update).toHaveBeenCalledWith(
      { deviceCode: expect.stringMatching(/^\d{9}$/) },
      { where: { id: 'device', ownerUserId: 1, revokedAt: null, deviceCode: null } },
    );
  });
  it('retries a code collision and persists a free code', async () => {
    database.findOne.mockResolvedValue({ deviceCode: null });
    database.update.mockRejectedValueOnce(new UniqueConstraintError({})).mockResolvedValueOnce([1]);
    const code = await ensureRemoteDeviceCode(host);
    expect(code).toMatch(/^\d{9}$/);
    expect(database.update).toHaveBeenCalledTimes(2);
    expect(database.update.mock.calls[1]![0]).toEqual({ deviceCode: code });
  });
  it('rejects missing, revoked or differently owned devices and propagates DB failures', async () => {
    database.findOne.mockResolvedValue(null);
    await expect(ensureRemoteDeviceCode(host)).rejects.toThrow('HOST_UNAVAILABLE');
    expect(database.findOne).toHaveBeenCalledWith({ where: { id: 'device', ownerUserId: 1, revokedAt: null } });
    database.findOne.mockResolvedValue({ deviceCode: null });
    database.update.mockRejectedValue(new Error('database unavailable'));
    await expect(ensureRemoteDeviceCode(host)).rejects.toThrow('database unavailable');
  });
});

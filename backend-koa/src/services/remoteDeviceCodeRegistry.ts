import { randomInt } from 'crypto';
import { UniqueConstraintError } from 'sequelize';
import { RemoteDevice } from '../models/RemoteControl';
import { RemoteControlError, type RemoteEndpoint } from './remoteControlProtocol';

/** The registered device owns the code; sockets and temporary passwords do not. */
export async function ensureRemoteDeviceCode(host: RemoteEndpoint): Promise<string> {
  const where = { id: host.endpointId, ownerUserId: host.userId, revokedAt: null };
  for (let attempt = 0; attempt < 5; attempt++) {
    const device = await RemoteDevice.findOne({ where });
    if (!device) throw new RemoteControlError('HOST_UNAVAILABLE', 403);
    if (device.deviceCode) return device.deviceCode;
    const code = String(randomInt(100_000_000, 1_000_000_000));
    try {
      // The conditional update keeps concurrent first connections from rotating a code.
      const [updated] = await RemoteDevice.update(
        { deviceCode: code },
        { where: { ...where, deviceCode: null } },
      );
      if (updated) return code;
    } catch (error) {
      // A nine-digit code can collide with another device; the DB is the authority.
      if (!(error instanceof UniqueConstraintError)) throw error;
    }
  }
  throw new RemoteControlError('REMOTE_CODE_ALLOCATION_FAILED', 503);
}

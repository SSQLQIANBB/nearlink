import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'crypto';
import type Redis from 'ioredis';
import { z } from 'zod';
import { canonicalJson, REMOTE_LIMITS, RemoteControlError, uuid } from './remoteControlProtocol';

export const deviceRegistrationSchema = z.object({
  challengeId: uuid, publicKey: z.string().min(32).max(1024),
  signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(128),
  alias: z.string().trim().min(1).max(80).refine(v => !/[\u0000-\u001f\u007f]/.test(v)),
  platform: z.enum(['macos', 'windows']),
}).strict();
export type RegistrationProof = z.infer<typeof deviceRegistrationSchema>;
export type DeviceChallenge = { id: string; nonce: string; userId: number; sid: string; action: 'register-device' | 'identify-device'; expiresAt: number };
export function registrationMessage(challenge: DeviceChallenge, data: Omit<RegistrationProof, 'signature' | 'challengeId'>) {
  return canonicalJson({ protocolVersion: 1, ...challenge, ...data });
}
export function verifyRegistrationProof(challenge: DeviceChallenge, input: RegistrationProof, userId: number, sid: string, now: number) {
  if (challenge.id !== input.challengeId || challenge.userId !== userId || challenge.sid !== sid
    || challenge.action !== 'register-device' || challenge.expiresAt <= now) throw new RemoteControlError('INVALID_DEVICE_PROOF', 403);
  try {
    const key = createPublicKey(input.publicKey);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('key type');
    const message = registrationMessage(challenge, { publicKey: input.publicKey, alias: input.alias, platform: input.platform });
    const bytes = Buffer.from(input.signature, 'base64');
    if (bytes.length !== 64 || !verify(null, Buffer.from(message), key, bytes)) throw new Error('signature');
    const der = key.export({ type: 'spki', format: 'der' });
    return { publicKey: key.export({ type: 'spki', format: 'pem' }).toString(), fingerprint: createHash('sha256').update(der).digest('hex') };
  } catch { throw new RemoteControlError('INVALID_DEVICE_PROOF', 403); }
}

export class RemoteDeviceChallengeStore {
  constructor(private readonly redis: Pick<Redis, 'set' | 'eval'>, private readonly now = Date.now) {}
  async create(userId: number, sid: string, action: DeviceChallenge['action'] = 'register-device'): Promise<DeviceChallenge> {
    const challenge: DeviceChallenge = { id: randomUUID(), nonce: randomBytes(32).toString('base64url'),
      userId, sid, action, expiresAt: this.now() + REMOTE_LIMITS.challengeMs };
    await this.redis.set(`remote:challenge:${challenge.id}`, JSON.stringify(challenge), 'PX', REMOTE_LIMITS.challengeMs);
    return challenge;
  }
  async consume(id: string, userId: number, sid: string, action: DeviceChallenge['action'] = 'register-device'): Promise<DeviceChallenge> {
    const raw = await this.redis.eval(`
local raw = redis.call('GET', KEYS[1])
if not raw then return false end
local challenge = cjson.decode(raw)
if challenge.userId ~= tonumber(ARGV[1]) or challenge.sid ~= ARGV[2] or challenge.action ~= ARGV[3] then return false end
redis.call('DEL', KEYS[1])
return raw`, 1, `remote:challenge:${id}`, userId, sid, action);
    if (typeof raw !== 'string') throw new RemoteControlError('INVALID_DEVICE_PROOF', 403);
    return JSON.parse(raw);
  }
}

export const deviceIdentitySchema = deviceRegistrationSchema.omit({ alias: true });
export type DeviceIdentityProof = z.infer<typeof deviceIdentitySchema>;
export function verifyDeviceIdentity(challenge: DeviceChallenge, input: DeviceIdentityProof, userId: number, sid: string, now: number) {
  if (challenge.id !== input.challengeId || challenge.userId !== userId || challenge.sid !== sid
    || challenge.action !== 'identify-device' || challenge.expiresAt <= now) throw new RemoteControlError('INVALID_DEVICE_PROOF', 403);
  try {
    const key = createPublicKey(input.publicKey);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('key type');
    const message = canonicalJson({ protocolVersion: 1, ...challenge, publicKey: input.publicKey, platform: input.platform });
    const signature = Buffer.from(input.signature, 'base64');
    if (signature.length !== 64 || !verify(null, Buffer.from(message), key, signature)) throw new Error('signature');
    return createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
  } catch { throw new RemoteControlError('INVALID_DEVICE_PROOF', 403); }
}

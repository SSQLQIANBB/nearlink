import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { createHash, createPublicKey } from 'crypto';
import { verifyDeviceIdentity, verifyRegistrationProof } from '../../../src/services/remoteDeviceProof';
const vector = JSON.parse(readFileSync(path.resolve(process.cwd(), '../fixtures/remote-device-identification-v1.json'), 'utf8'));
describe('本机设备识别证明', () => {
  it('验签跨语言测试向量，返回登记公钥的指纹', () => {
    const expected = createHash('sha256').update(createPublicKey(vector.proof.publicKey).export({ format: 'der', type: 'spki' })).digest('hex');
    expect(verifyDeviceIdentity(vector.challenge, vector.proof, vector.challenge.userId, vector.challenge.sid, vector.now)).toBe(expected);
  });
  it('登记与识别用途不互通，账号/会话/过期/篡改都拒绝', () => {
    const { challenge: c, proof: p, now } = vector;
    expect(() => verifyDeviceIdentity({ ...c, action: 'register-device' }, p, c.userId, c.sid, now)).toThrow();
    expect(() => verifyRegistrationProof(c, { ...p, alias: 'test' }, c.userId, c.sid, now)).toThrow();
    expect(() => verifyDeviceIdentity(c, p, 999, c.sid, now)).toThrow();
    expect(() => verifyDeviceIdentity(c, p, c.userId, 'other-session', now)).toThrow();
    expect(() => verifyDeviceIdentity(c, p, c.userId, c.sid, c.expiresAt)).toThrow();
    expect(() => verifyDeviceIdentity(c, { ...p, platform: 'windows' }, c.userId, c.sid, now)).toThrow();
  });
});

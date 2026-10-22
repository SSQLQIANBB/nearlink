/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateKeyPairSync, sign, webcrypto } from 'node:crypto';
import {
  verifyRemoteProof,
  type RemotePeerBinding,
  type RemoteProofClaims,
} from '@/services/remoteControlProof';
const keyPair = generateKeyPairSync('ed25519');
const key = {
  keyId: 'test:key',
  publicKey: keyPair.publicKey
    .export({ type: 'spki', format: 'der' })
    .subarray(-32)
    .toString('base64url'),
  notBefore: 0,
  notAfter: 100000,
};
const endpoint = {
  userId: 1,
  sid: '11111111-1111-4111-8111-111111111111',
  authVersion: '22222222-2222-4222-8222-222222222222',
  endpointId: 'device',
  connectionId: 'connection',
  generation: 1,
};
const binding: RemotePeerBinding = {
  sessionId: '33333333-3333-4333-8333-333333333333',
  host: endpoint,
  controller: { ...endpoint, userId: 2 },
  negotiationId: '44444444-4444-4444-8444-444444444444',
  hostFingerprint: 'A'.repeat(64),
  controllerFingerprint: 'B'.repeat(64),
  consentNonce: Buffer.alloc(32, 1).toString('base64url'),
  screenId: 'screen',
};
const claims: RemoteProofClaims = {
  ...binding,
  protocolVersion: 1,
  issuer: 'todesk-remote-control',
  audience: 'todesk-remote-peer',
  purpose: 'lease',
  scope: 'control',
  authorizationRevision: 1,
  controlEpoch: 1,
  issuedAt: 1000,
  expiresAt: 16000,
  leaseSeq: 1,
  challenge: Buffer.alloc(32, 2).toString('base64url'),
};
function envelope(values: object = claims) {
  const payload = Buffer.from(JSON.stringify(values)).toString('base64url');
  return {
    format: 'rc-signed-v1' as const,
    keyId: key.keyId,
    payload,
    signature: sign(
      null,
      Buffer.from(`todesk-remote-control/v1\n${key.keyId}\n${payload}`),
      keyPair.privateKey,
    ).toString('base64url'),
  };
}
beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('主控验签与DTLS绑定', () => {
  it.each([-86_400_000, 86_400_000])('本机时钟偏差 %i 毫秒仍以签名寿命和单调时钟验证真实Ed25519凭据', async (offset) => {
    vi.spyOn(Date, 'now').mockReturnValue(claims.issuedAt + offset);
    const proof = await verifyRemoteProof(envelope(), [key], binding, 'lease', {
      monotonic: 500,
    });
    expect(proof.deadline).toBe(15500);
  });
  it('payload篡改、未知keyId和不同用途全部拒绝', async () => {
    const signed = envelope();
    await expect(
      verifyRemoteProof(
        { ...signed, payload: envelope({ ...claims, scope: 'view' }).payload },
        [key],
        binding,
        'lease',
        { monotonic: 0 },
      ),
    ).rejects.toThrow('REMOTE_PROOF_SIGNATURE');
    await expect(
      verifyRemoteProof({ ...signed, keyId: 'unknown' }, [key], binding, 'lease'),
    ).rejects.toThrow('REMOTE_PROOF_KEY');
    await expect(
      verifyRemoteProof(signed, [key], binding, 'connection', { monotonic: 0 }),
    ).rejects.toThrow('REMOTE_PROOF_PURPOSE');
  });
  it('绑定另一DTLS端点、会话或连接代次的有效签名仍然拒绝', async () => {
    for (const changed of [
      { ...binding, hostFingerprint: 'C'.repeat(64) },
      { ...binding, sessionId: 'other' },
      { ...binding, host: { ...endpoint, generation: 2 } },
    ]) {
      await expect(
        verifyRemoteProof(envelope(), [key], changed, 'lease', { monotonic: 0 }),
      ).rejects.toThrow('REMOTE_PROOF_BINDING');
    }
  });
  it('拒绝超过15秒或无有效寿命的租约以及无challenge租约', async () => {
    await expect(
      verifyRemoteProof(envelope({ ...claims, expiresAt: 16001 }), [key], binding, 'lease', {
        monotonic: 0,
      }),
    ).rejects.toThrow('REMOTE_PROOF_EXPIRED');
    await expect(
      verifyRemoteProof(envelope({ ...claims, expiresAt: claims.issuedAt }), [key], binding, 'lease', { monotonic: 0 }),
    ).rejects.toThrow('REMOTE_PROOF_EXPIRED');
    await expect(
      verifyRemoteProof(envelope({ ...claims, challenge: undefined }), [key], binding, 'lease', {
        monotonic: 0,
      }),
    ).rejects.toThrow('REMOTE_PROOF_CHALLENGE');
  });
  it('拒绝合法签名下的未知字段、反向时间、key有效期外及连接租约混用', async () => {
    for (const invalid of [
      { ...claims, extra: true },
      { ...claims, host: { ...claims.host, extra: true } },
      { ...claims, issuedAt: claims.expiresAt + 1 },
      { ...claims, authorizationRevision: 0 },
      { ...claims, purpose: 'connection' },
    ])
      await expect(
        verifyRemoteProof(
          envelope(invalid),
          [key],
          binding,
          invalid.purpose as 'connection' | 'lease',
          { monotonic: 0 },
        ),
      ).rejects.toThrow();
    await expect(
      verifyRemoteProof(envelope(), [{ ...key, notBefore: 1001 }], binding, 'lease', {
        monotonic: 0,
      }),
    ).rejects.toThrow('REMOTE_PROOF_EXPIRED');
    await expect(
      verifyRemoteProof(envelope(), [{ ...key, notAfter: 15000 }], binding, 'lease', {
        monotonic: 0,
      }),
    ).rejects.toThrow('REMOTE_PROOF_EXPIRED');
    await expect(
      verifyRemoteProof(
        { ...envelope(), url: 'https://untrusted.invalid' },
        [key],
        binding,
        'lease',
        { monotonic: 0 },
      ),
    ).rejects.toThrow('REMOTE_PROOF_FORMAT');
  });
  it('可验证后端生成的共享Ed25519互通样例', async () => {
    const fixture = JSON.parse(
      readFileSync(
        resolve(process.cwd(), '../fixtures/remote-control-credentials-v1.json'),
        'utf8',
      ),
    );
    const proof = await verifyRemoteProof(
      fixture.connection,
      [fixture.key],
      fixture.claims,
      'connection',
      { monotonic: 50 },
    );
    expect(proof.deadline).toBe(30050);
    expect(proof.claims).toEqual(fixture.claims);
  });
});

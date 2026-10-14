import { describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import {
  RemoteCredentialSigner,
  remoteCredentialSignerFromEnvironment,
  remoteSignatureMessage,
  verifyHostConsent,
  verifyRemoteCredential,
  verifyRemoteApproval,
  type HostConsentClaims,
} from '../../../src/services/remoteCredentials';
import {
  transitionRemoteSession,
  type RemoteSession,
} from '../../../src/services/remoteControlProtocol';
import {
  registrationMessage,
  verifyRegistrationProof,
} from '../../../src/services/remoteDeviceProof';

function fixture() {
  const now = 1_700_000_000_000;
  const endpoint = (userId: number) => ({
    userId,
    sid: randomUUID(),
    authVersion: randomUUID(),
    endpointId: randomUUID(),
    connectionId: randomUUID(),
    generation: 1,
  });
  const pending: RemoteSession = {
    id: randomUUID(),
    requestId: randomUUID(),
    requestHash: 'hash',
    grantId: randomUUID(),
    host: endpoint(1),
    controller: endpoint(2),
    state: 'pending',
    scope: 'view',
    requestedScope: 'control',
    revision: 0,
    authorizationRevision: 0,
    controlEpoch: 0,
    controllerReady: false,
    hostReady: false,
    createdAt: now,
    deadline: now + 45_000,
    hardDeadline: now + 3_600_000,
  };
  const pair = generateKeyPairSync('ed25519');
  const device = {
    id: pending.host.endpointId,
    ownerUserId: 1,
    keyVersion: 1,
    revokedAt: null,
    fingerprint: createHash('sha256')
      .update(pair.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex'),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
  const consentClaims: HostConsentClaims = {
    protocolVersion: 1,
    purpose: 'host-consent',
    action: 'accept',
    approvalId: randomUUID(),
    authorizationRevision: 1,
    controlEpoch: 1,
    sessionId: pending.id,
    host: pending.host,
    controller: pending.controller,
    requestedScope: 'control',
    decision: 'control',
    consentNonce: randomBytes(32).toString('base64url'),
    screenId: 'display-1',
    issuedAt: now,
    expiresAt: now + 30_000,
  };
  const proof = (claims: HostConsentClaims) => {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const keyId = `device:${device.id}:1`;
    return {
      format: 'rc-signed-v1',
      keyId,
      payload,
      signature: sign(null, remoteSignatureMessage(keyId, payload), pair.privateKey).toString(
        'base64url',
      ),
    };
  };
  const consent = verifyHostConsent(proof(consentClaims), pending, device, now);
  const connecting = transitionRemoteSession(
    pending,
    pending.host,
    { type: 'respond', accepted: true, scope: 'control' },
    now,
  );
  const active = transitionRemoteSession(
    transitionRemoteSession(connecting, pending.host, { type: 'ready' }, now),
    pending.controller,
    { type: 'ready' },
    now,
  );
  const signingPair = generateKeyPairSync('ed25519');
  const signer = new RemoteCredentialSigner(
    'test-key',
    signingPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    now - 1000,
    now + 3_600_000,
  );
  const binding = {
    negotiationId: randomUUID(),
    hostFingerprint: 'AB'.repeat(32),
    controllerFingerprint: 'CD'.repeat(32),
  };
  return {
    now,
    pending,
    device,
    proof,
    consentClaims,
    consent,
    connecting,
    active,
    signer,
    binding,
  };
}

describe('remote signed authority', () => {
  it('shares native registration, signed prompt and approval response vectors with Rust', () => {
    const vector = JSON.parse(
      readFileSync(
        path.resolve(__dirname, '../../../../fixtures/remote-control-native-approval-v1.json'),
        'utf8',
      ),
    );
    expect(verifyRemoteApproval(vector.approval, vector.key, vector.now)).toEqual(
      vector.approvalClaims,
    );
    const pending = {
      ...fixture().pending,
      id: vector.approvalClaims.sessionId,
      host: vector.approvalClaims.host,
      controller: vector.approvalClaims.controller,
      deadline: vector.approvalClaims.expiresAt,
      hardDeadline: vector.approvalClaims.sessionExpiresAt,
    };
    expect(verifyHostConsent(vector.consent, pending, vector.device, vector.now).claims).toEqual(
      vector.consentClaims,
    );
    const { publicKey, alias, platform } = vector.registration;
    expect(registrationMessage(vector.registrationChallenge, { publicKey, alias, platform })).toBe(
      vector.registrationMessage,
    );
    expect(
      verifyRegistrationProof(
        vector.registrationChallenge,
        vector.registration,
        pending.host.userId,
        pending.host.sid,
        vector.now,
      ),
    ).toMatchObject({ fingerprint: vector.device.fingerprint, publicKey });
  });
  it('signs a short-lived native-only prompt bound to device identity and next authorization revision', () => {
    const f = fixture();
    const id = randomUUID();
    const prompt = f.signer.issueApprovalRequest(f.pending, f.device, id, f.now);
    expect(verifyRemoteApproval(prompt, f.signer.publicKey, f.now)).toEqual({
      protocolVersion: 1,
      issuer: 'todesk-remote-control',
      audience: 'todesk-native-approval',
      purpose: 'approval-request',
      approvalId: id,
      action: 'accept',
      sessionId: f.pending.id,
      host: f.pending.host,
      controller: f.pending.controller,
      requestedScope: 'control',
      authorizationRevision: 1,
      controlEpoch: 1,
      hostKeyVersion: 1,
      hostKeyFingerprint: f.device.fingerprint,
      screenId: 'primary',
      issuedAt: f.now,
      expiresAt: f.now + 45_000,
      sessionExpiresAt: f.pending.hardDeadline,
    });
    expect(() => verifyRemoteCredential(prompt, f.signer.publicKey, f.now)).toThrow();
    expect(() => verifyRemoteApproval(prompt, f.signer.publicKey, f.now + 45_000)).toThrow();
    expect(() =>
      verifyRemoteApproval({ ...prompt, signature: 'A'.repeat(86) }, f.signer.publicKey, f.now),
    ).toThrow();
    expect(() =>
      f.signer.issueApprovalRequest(f.pending, { ...f.device, revokedAt: new Date() }, id, f.now),
    ).toThrow();
    expect(() =>
      f.signer.issueApprovalRequest(f.pending, { ...f.device, ownerUserId: 2 }, id, f.now),
    ).toThrow();
    expect(() => f.signer.issueApprovalRequest(f.connecting, f.device, id, f.now)).toThrow();
    expect(() => f.signer.issueApprovalRequest(f.active, f.device, id, f.now)).toThrow();
    const paused = transitionRemoteSession(f.active, f.active.host, { type: 'pause' }, f.now);
    expect(
      verifyRemoteApproval(
        f.signer.issueApprovalRequest(paused, f.device, randomUUID(), f.now),
        f.signer.publicKey,
        f.now,
      ),
    ).toMatchObject({
      action: 'grant-control',
      requestedScope: 'control',
      authorizationRevision: 3,
      controlEpoch: 3,
    });
  });
  it('shares one signed wire vector with the Rust and browser verifiers', () => {
    const vector = JSON.parse(
      readFileSync(
        path.resolve(__dirname, '../../../../fixtures/remote-control-credentials-v1.json'),
        'utf8',
      ),
    );
    expect(verifyRemoteCredential(vector.connection, vector.key, vector.now)).toEqual(
      vector.claims,
    );
    expect(verifyRemoteCredential(vector.lease, vector.key, vector.now)).toMatchObject({
      purpose: 'lease',
      leaseSeq: 1,
    });
  });
  it('device signature binds the pending request and exact connection identities', () => {
    const f = fixture();
    for (const claims of [
      { ...f.consentClaims, host: { ...f.pending.host, generation: 2 } },
      { ...f.consentClaims, controller: { ...f.pending.controller, sid: randomUUID() } },
      { ...f.consentClaims, authorizationRevision: 2 },
      { ...f.consentClaims, expiresAt: f.now },
    ]) {
      expect(() => verifyHostConsent(f.proof(claims), f.pending, f.device, f.now)).toThrow();
    }
    expect(() =>
      verifyHostConsent(
        f.proof(f.consentClaims),
        f.pending,
        { ...f.device, revokedAt: new Date() },
        f.now,
      ),
    ).toThrow();
    expect(() =>
      verifyHostConsent(
        f.proof(f.consentClaims),
        { ...f.pending, requestedScope: 'view' },
        f.device,
        f.now,
      ),
    ).toThrow();
  });

  it('connection and media credentials are separate and cryptographically verifiable', () => {
    const f = fixture();
    const connection = f.signer.issueConnection(f.connecting, f.consent, f.binding, f.now);
    expect(verifyRemoteCredential(connection, f.signer.publicKey, f.now)).toMatchObject({
      purpose: 'connection',
      ...f.binding,
      scope: 'control',
    });
    expect(() =>
      f.signer.issueLease(
        f.connecting,
        f.consent,
        f.binding,
        randomBytes(32).toString('base64url'),
        1,
        f.now,
      ),
    ).toThrow();
    const lease = f.signer.issueLease(
      f.active,
      f.consent,
      f.binding,
      randomBytes(32).toString('base64url'),
      1,
      f.now,
    );
    const claims = verifyRemoteCredential(lease, f.signer.publicKey, f.now);
    expect(claims.expiresAt - f.now).toBe(15_000);
    expect(claims.leaseSeq).toBe(1);
    expect(() => verifyRemoteCredential(lease, f.signer.publicKey, claims.expiresAt)).toThrow();
    expect(() => f.signer.issueConnection(f.pending, f.consent, f.binding, f.now)).toThrow();
  });

  it('ordinary objects, modified credentials, alternate kids and unknown fields cannot confer authority', () => {
    const f = fixture();
    expect(() =>
      f.signer.issueConnection(f.connecting, { ...f.consent }, f.binding, f.now),
    ).toThrow();
    const token = f.signer.issueConnection(f.connecting, f.consent, f.binding, f.now);
    for (const forged of [
      { ...token, keyId: 'unknown' },
      { ...token, signature: 'A'.repeat(86) },
      { ...token, payload: `${token.payload}A` },
      { ...token, algorithm: 'none' },
      { ...token, keyUrl: 'https://example.test/key' },
    ]) {
      expect(() => verifyRemoteCredential(forged, f.signer.publicKey, f.now)).toThrow();
    }
    expect(() =>
      verifyRemoteCredential(token, { ...f.signer.publicKey, notBefore: f.now + 1 }, f.now),
    ).toThrow();
    expect(Object.isFrozen(f.consent.claims.host)).toBe(true);
    // Runtime JSON can contain fields erased by TypeScript's static types.
    expect(() =>
      f.signer.issueConnection(
        f.connecting,
        f.consent,
        {
          ...f.binding,
          purpose: 'lease',
          leaseSeq: 1,
          challenge: randomBytes(32).toString('base64url'),
        } as any,
        f.now,
      ),
    ).toThrow();
  });

  it('old control consent permits a downgrade, never a control restoration', () => {
    const f = fixture();
    const paused = transitionRemoteSession(f.active, f.active.host, { type: 'pause' }, f.now);
    const challenge = randomBytes(32).toString('base64url');
    expect(
      verifyRemoteCredential(
        f.signer.issueLease(paused, f.consent, f.binding, challenge, 2, f.now),
        f.signer.publicKey,
        f.now,
      ).scope,
    ).toBe('view');
    const restored = transitionRemoteSession(paused, paused.host, { type: 'grant-control' }, f.now);
    expect(() =>
      f.signer.issueLease(restored, f.consent, f.binding, challenge, 3, f.now),
    ).toThrow();
    const newConsent = verifyHostConsent(
      f.proof({
        ...f.consentClaims,
        action: 'grant-control',
        authorizationRevision: restored.authorizationRevision,
        controlEpoch: restored.controlEpoch,
        consentNonce: randomBytes(32).toString('base64url'),
      }),
      paused,
      f.device,
      f.now,
    );
    expect(
      verifyRemoteCredential(
        f.signer.issueLease(restored, newConsent, f.binding, challenge, 3, f.now),
        f.signer.publicKey,
        f.now,
      ).scope,
    ).toBe('control');
  });

  it('missing deployment keys never fall back to account JWT or randomly generated signing keys', () => {
    expect(remoteCredentialSignerFromEnvironment({ JWT_SECRET: 'ignored' })).toBeNull();
    expect(() =>
      remoteCredentialSignerFromEnvironment({ REMOTE_CONTROL_SIGNING_KEY_ID: 'partial' }),
    ).toThrow();
  });
});

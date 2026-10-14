import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, randomUUID, sign } from 'crypto';
import {
  endRemoteSession,
  REMOTE_LIMITS,
  transitionRemoteSession,
  type RemoteEndpoint,
  type RemoteSession,
} from '../../../src/services/remoteControlProtocol';
import {
  registrationMessage,
  verifyRegistrationProof,
  type DeviceChallenge,
} from '../../../src/services/remoteDeviceProof';

const controller: RemoteEndpoint = {
  userId: 1,
  sid: 'login-1',
  authVersion: 'v1',
  endpointId: 'web-1',
  connectionId: 'socket-1',
  generation: 1,
};
const host: RemoteEndpoint = {
  userId: 2,
  sid: 'login-2',
  authVersion: 'v2',
  endpointId: 'device-2',
  connectionId: 'socket-2',
  generation: 4,
};
function pending(): RemoteSession {
  return {
    id: randomUUID(),
    requestId: randomUUID(),
    requestHash: 'hash',
    grantId: randomUUID(),
    controller,
    host,
    requestedScope: 'control',
    scope: 'view',
    state: 'pending',
    revision: 0,
    authorizationRevision: 0,
    controlEpoch: 0,
    controllerReady: false,
    hostReady: false,
    createdAt: 0,
    deadline: REMOTE_LIMITS.requestMs,
    hardDeadline: REMOTE_LIMITS.sessionMs,
  };
}
function active() {
  let session = transitionRemoteSession(
    pending(),
    host,
    { type: 'respond', accepted: true, scope: 'control' },
    1,
  );
  session = transitionRemoteSession(session, controller, { type: 'ready' }, 2);
  return transitionRemoteSession(session, host, { type: 'ready' }, 3);
}

describe('远控授权状态', () => {
  it('同账号、伪造Socket和旧连接代次均不能代替目标设备确认', () => {
    const session = pending();
    for (const impostor of [
      controller,
      { ...host, generation: 3 },
      { ...host, connectionId: 'other' },
      { ...host, sid: 'old' },
    ]) {
      expect(() =>
        transitionRemoteSession(
          session,
          impostor,
          { type: 'respond', accepted: true, scope: 'control' },
          1,
        ),
      ).toThrow();
    }
  });
  it('只观看请求不能被扩大为直接控制，两端ready不改变授权版本', () => {
    const session = { ...pending(), requestedScope: 'view' as const };
    expect(() =>
      transitionRemoteSession(
        session,
        host,
        { type: 'respond', accepted: true, scope: 'control' },
        1,
      ),
    ).toThrow('SCOPE_ESCALATION');
    const approved = transitionRemoteSession(
      session,
      host,
      { type: 'respond', accepted: true, scope: 'view' },
      1,
    );
    const first = transitionRemoteSession(approved, host, { type: 'ready' }, 2);
    expect(first.state).toBe('connecting');
    const second = transitionRemoteSession(first, controller, { type: 'ready' }, 3);
    expect(second.state).toBe('active');
    expect(second.scope).toBe('view');
    expect(second.authorizationRevision).toBe(approved.authorizationRevision);
  });
  it('暂停立即降为观看，旧主控无权自己恢复控制', () => {
    const previous = active();
    const paused = transitionRemoteSession(previous, host, { type: 'pause' }, 4);
    expect(paused.scope).toBe('view');
    expect(paused.controlEpoch).toBeGreaterThan(previous.controlEpoch);
    expect(() =>
      transitionRemoteSession(paused, controller, { type: 'grant-control' }, 5),
    ).toThrow();
    const restored = transitionRemoteSession(paused, host, { type: 'grant-control' }, 5);
    expect(restored.controlEpoch).toBeGreaterThan(paused.controlEpoch);
  });
  it('取消、到期和结束为不可恢复终态，重复结束不延长期限', () => {
    const cancelled = transitionRemoteSession(pending(), controller, { type: 'cancel' }, 2);
    expect(() =>
      transitionRemoteSession(
        cancelled,
        host,
        { type: 'respond', accepted: true, scope: 'control' },
        3,
      ),
    ).toThrow('SESSION_ENDED');
    expect(endRemoteSession(cancelled, 'ENDED', 10)).toBe(cancelled);
    const expired = transitionRemoteSession(
      pending(),
      host,
      { type: 'respond', accepted: true, scope: 'control' },
      REMOTE_LIMITS.requestMs,
    );
    expect(expired.state).toBe('ended');
    expect(expired.reason).toBe('EXPIRED');
  });
});

describe('原生设备所有权证明', () => {
  it('使用真实Ed25519验证绑定账号、登录会话、nonce和设备元数据', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const challenge: DeviceChallenge = {
      id: randomUUID(),
      nonce: 'random-nonce',
      userId: 1,
      sid: 'login-1',
      action: 'register-device',
      expiresAt: 10_000,
    };
    const data = {
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      alias: 'Mac',
      platform: 'macos' as const,
    };
    const signature = sign(
      null,
      Buffer.from(registrationMessage(challenge, data)),
      privateKey,
    ).toString('base64');
    const proof = { ...data, signature, challengeId: challenge.id };
    expect(verifyRegistrationProof(challenge, proof, 1, 'login-1', 1).fingerprint).toMatch(
      /^[a-f0-9]{64}$/,
    );
    for (const altered of [
      { ...proof, alias: 'other' },
      { ...proof, platform: 'windows' as const },
      { ...proof, signature: Buffer.alloc(64).toString('base64') },
    ]) {
      expect(() => verifyRegistrationProof(challenge, altered, 1, 'login-1', 1)).toThrow(
        'INVALID_DEVICE_PROOF',
      );
    }
    expect(() => verifyRegistrationProof(challenge, proof, 2, 'login-1', 1)).toThrow();
    expect(() => verifyRegistrationProof(challenge, proof, 1, 'another-login', 1)).toThrow();
    expect(() => verifyRegistrationProof(challenge, proof, 1, 'login-1', 10_000)).toThrow();
  });
});

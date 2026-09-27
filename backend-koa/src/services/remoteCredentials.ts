import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'crypto';
import { z } from 'zod';
import { iceConfigurationSchema, type RemoteIceConfiguration } from './remoteIce';
import { isEndpoint, RemoteControlError, REMOTE_LIMITS, type RemoteSession } from './remoteControlProtocol';

export const REMOTE_SIGNATURE_DOMAIN = 'todesk-remote-control/v1';
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = integer.positive();
const uuid = z.string().uuid();
const identifier = z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/);
const nonce = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
  .refine(value => Buffer.from(value, 'base64url').toString('base64url') === value);
const fingerprint = z.string().regex(/^[A-F0-9]{64}$/);
const endpoint = z.object({ userId: positive, sid: uuid, authVersion: uuid, endpointId: identifier,
  connectionId: identifier, generation: positive }).strict();
const scope = z.enum(['view', 'control']);
const envelopeSchema = z.object({ format: z.literal('rc-signed-v1'), keyId: identifier,
  payload: z.string().min(1).max(16_384).regex(/^[A-Za-z0-9_-]+$/),
  signature: z.string().length(86).regex(/^[A-Za-z0-9_-]+$/) }).strict();
export type SignedRemoteEnvelope = z.infer<typeof envelopeSchema>;
export type RemotePublicSigningKey = { keyId: string; publicKey: string; notBefore: number; notAfter: number };

const consentSchema = z.object({ protocolVersion: z.literal(1), purpose: z.literal('host-consent'),
  approvalId: uuid, action: z.enum(['accept', 'grant-control']), authorizationRevision: positive, controlEpoch: positive,
  sessionId: uuid, host: endpoint, controller: endpoint, requestedScope: scope,
  decision: z.enum(['view', 'control', 'reject']), consentNonce: nonce, screenId: z.string().min(1).max(128),
  issuedAt: integer, expiresAt: positive }).strict();
export type HostConsentClaims = z.infer<typeof consentSchema>;
const approvalSchema = z.object({ protocolVersion: z.literal(1), issuer: z.literal('todesk-remote-control'),
  audience: z.literal('todesk-native-approval'), purpose: z.literal('approval-request'), approvalId: uuid,
  action: z.enum(['accept', 'grant-control']), sessionId: uuid, host: endpoint, controller: endpoint,
  requestedScope: scope, authorizationRevision: positive, controlEpoch: positive,
  hostKeyVersion: positive, hostKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  screenId: z.literal('primary'), issuedAt: integer, expiresAt: positive, sessionExpiresAt: positive,
}).strict();
export type RemoteApprovalClaims = z.infer<typeof approvalSchema>;
export type ApprovalHostDevice = { id: string; ownerUserId: number; keyVersion: number; fingerprint: string; revokedAt: Date | null };
const credentialSchema = z.object({ protocolVersion: z.literal(1), issuer: z.literal('todesk-remote-control'),
  audience: z.literal('todesk-remote-peer'), purpose: z.enum(['connection', 'lease']), sessionId: uuid,
  host: endpoint, controller: endpoint, negotiationId: uuid, hostFingerprint: fingerprint,
  controllerFingerprint: fingerprint, consentNonce: nonce, screenId: z.string().min(1).max(128), scope,
  authorizationRevision: positive, controlEpoch: integer, issuedAt: integer, expiresAt: positive,
  leaseSeq: positive.optional(), challenge: nonce.optional(),
}).strict().superRefine((value, context) => {
  if ((value.purpose === 'lease') !== (value.leaseSeq !== undefined && value.challenge !== undefined)
    || (value.purpose === 'connection' && (value.leaseSeq !== undefined || value.challenge !== undefined))) {
    context.addIssue({ code: 'custom', message: 'Invalid lease fields' });
  }
});
export type RemoteCredentialClaims = z.infer<typeof credentialSchema>;
export type RemoteTransportBinding = Pick<RemoteCredentialClaims, 'negotiationId' | 'hostFingerprint' | 'controllerFingerprint'>;
const transportBindingSchema = z.object({ negotiationId: uuid, hostFingerprint: fingerprint, controllerFingerprint: fingerprint }).strict();
const consentAuthority = new WeakSet<object>();
export type VerifiedHostConsent = Readonly<{ claims: Readonly<HostConsentClaims>; hostKeyVersion: number }>;

export function remoteSignatureMessage(keyId: string, payload: string): Buffer {
  return Buffer.from(`${REMOTE_SIGNATURE_DOMAIN}\n${keyId}\n${payload}`, 'utf8');
}
function fail(): never { throw new RemoteControlError('INVALID_REMOTE_CREDENTIAL', 403); }
function decode(envelope: unknown, key: KeyObject, expectedKeyId: string): unknown {
  const parsed = envelopeSchema.safeParse(envelope);
  if (!parsed.success || parsed.data.keyId !== expectedKeyId || key.asymmetricKeyType !== 'ed25519') return fail();
  const { keyId, payload, signature } = parsed.data;
  const bytes = Buffer.from(payload, 'base64url'), signatureBytes = Buffer.from(signature, 'base64url');
  if (bytes.toString('base64url') !== payload || signatureBytes.toString('base64url') !== signature
    || signatureBytes.length !== 64 || bytes.length > 12_288
    || !verify(null, remoteSignatureMessage(keyId, payload), key, signatureBytes)) return fail();
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return fail(); }
}
/** Internal native-evidence verifier. Callers must validate a purpose-specific schema and binding. */
export function decodeRemoteDeviceEvidence(envelope: unknown, device: { id: string; publicKey: string; keyVersion: number; revokedAt: Date | null }): unknown {
  if (device.revokedAt) return fail();
  return decode(envelope, createPublicKey(device.publicKey), `device:${device.id}:${device.keyVersion}`);
}
function signed(keyId: string, claims: object, privateKey: KeyObject): SignedRemoteEnvelope {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return { format: 'rc-signed-v1', keyId, payload,
    signature: sign(null, remoteSignatureMessage(keyId, payload), privateKey).toString('base64url') };
}

/** Verifies device-key possession. Trusted local UI/key custody is enforced by the native supervisor. */
export function verifyHostConsent(envelope: unknown, session: RemoteSession,
  device: { id: string; ownerUserId: number; publicKey: string; keyVersion: number; revokedAt: Date | null }, now: number): VerifiedHostConsent {
  if (!['pending', 'active'].includes(session.state) || session.deadline <= now || session.hardDeadline <= now || device.revokedAt
    || device.id !== session.host.endpointId || device.ownerUserId !== session.host.userId) return fail();
  let body: unknown;
  try { body = decode(envelope, createPublicKey(device.publicKey), `device:${device.id}:${device.keyVersion}`); }
  catch { return fail(); }
  const parsed = consentSchema.safeParse(body);
  if (!parsed.success) return fail();
  const claims = parsed.data;
  const accepting = claims.action === 'accept' && session.state === 'pending';
  const restoring = claims.action === 'grant-control' && session.state === 'active' && session.scope === 'view';
  if (claims.sessionId !== session.id || !isEndpoint(session.host, claims.host) || !isEndpoint(session.controller, claims.controller)
    || (!accepting && !restoring) || claims.authorizationRevision !== session.authorizationRevision + 1
    || claims.controlEpoch !== session.controlEpoch + 1
    || claims.requestedScope !== (accepting ? session.requestedScope : 'control')
    || (claims.decision === 'control' && claims.requestedScope !== 'control')
    || claims.issuedAt > now || claims.expiresAt <= now || claims.expiresAt > session.deadline
    || claims.expiresAt - claims.issuedAt > REMOTE_LIMITS.requestMs) return fail();
  // Clone/freeze every nested field. A verified object's identity, not a caller-supplied boolean, carries authority.
  Object.freeze(claims.host); Object.freeze(claims.controller); Object.freeze(claims);
  const result = Object.freeze({ claims, hostKeyVersion: device.keyVersion });
  consentAuthority.add(result);
  return result;
}

export class RemoteCredentialSigner {
  private readonly key: KeyObject;
  readonly publicKey: Readonly<RemotePublicSigningKey>;
  issuePresenceChallenge(host: import('./remoteControlProtocol').RemoteEndpoint, device: ApprovalHostDevice, challenge: string, now = Date.now()) {
    endpoint.parse(host); nonce.parse(challenge);
    if (device.revokedAt || device.id !== host.endpointId || device.ownerUserId !== host.userId
      || now < this.publicKey.notBefore || now + REMOTE_LIMITS.challengeMs > this.publicKey.notAfter) return fail();
    return signed(this.publicKey.keyId, { protocolVersion: 1, issuer: 'todesk-remote-control',
      audience: 'todesk-native-presence', purpose: 'presence-challenge', host, challenge,
      hostKeyVersion: device.keyVersion, hostKeyFingerprint: device.fingerprint,
      issuedAt: now, expiresAt: now + REMOTE_LIMITS.challengeMs }, this.key);
  }
  /** Called only after the ICE service revalidates live session and durable authority. */
  issueIceConfiguration(session: RemoteSession, configuration: RemoteIceConfiguration, now = Date.now()) {
    integer.parse(now);
    configuration = iceConfigurationSchema.parse(configuration);
    endpoint.parse(session.host); endpoint.parse(session.controller); uuid.parse(session.id);
    if (!['connecting', 'active'].includes(session.state) || session.authorizationRevision < 1
      || session.deadline <= now || session.hardDeadline <= now || session.hardDeadline > now + REMOTE_LIMITS.sessionMs
      || now < this.publicKey.notBefore || configuration.expiresAt > this.publicKey.notAfter
      || configuration.expiresAt <= session.hardDeadline || configuration.expiresAt > session.hardDeadline + 300_000)
      throw new RemoteControlError('REMOTE_ICE_SIGNING_WINDOW', 503);
    return signed(this.publicKey.keyId, { protocolVersion: 1, issuer: 'todesk-remote-control', audience: 'todesk-native-ice', purpose: 'ice-config',
      sessionId: session.id, host: session.host, controller: session.controller, issuedAt: now,
      sessionExpiresAt: session.hardDeadline, ...configuration }, this.key);
  }
  constructor(keyId: string, pem: string, notBefore: number, notAfter: number) {
    identifier.parse(keyId); integer.parse(notBefore); positive.parse(notAfter);
    if (notAfter <= notBefore) throw new Error('REMOTE_SIGNING_KEY_WINDOW_INVALID');
    this.key = createPrivateKey(pem);
    if (this.key.asymmetricKeyType !== 'ed25519') throw new Error('REMOTE_SIGNING_KEY_TYPE_INVALID');
    const jwk = createPublicKey(this.key).export({ format: 'jwk' });
    this.publicKey = Object.freeze({ keyId, publicKey: jwk.x!, notBefore, notAfter });
  }

  /** A native prompt is meaningful only after current host/controller authority has been checked. */
  issueApprovalRequest(session: RemoteSession, device: ApprovalHostDevice, approvalId: string, now = Date.now()) {
    integer.parse(now);
    const accepting = session.state === 'pending';
    const restoring = session.state === 'active' && session.scope === 'view';
    if ((!accepting && !restoring) || device.revokedAt || device.id !== session.host.endpointId
      || device.ownerUserId !== session.host.userId || session.deadline <= now || session.hardDeadline <= now
      || session.hardDeadline > now + REMOTE_LIMITS.sessionMs || now < this.publicKey.notBefore || now >= this.publicKey.notAfter) return fail();
    const claims = approvalSchema.parse({ protocolVersion: 1, issuer: 'todesk-remote-control',
      audience: 'todesk-native-approval', purpose: 'approval-request', approvalId,
      action: accepting ? 'accept' : 'grant-control', sessionId: session.id, host: session.host, controller: session.controller,
      requestedScope: accepting ? session.requestedScope : 'control', authorizationRevision: session.authorizationRevision + 1,
      controlEpoch: session.controlEpoch + 1, hostKeyVersion: device.keyVersion, hostKeyFingerprint: device.fingerprint,
      screenId: 'primary', issuedAt: now,
      expiresAt: Math.min(now + REMOTE_LIMITS.requestMs, session.deadline, session.hardDeadline, this.publicKey.notAfter),
      sessionExpiresAt: session.hardDeadline });
    return signed(this.publicKey.keyId, claims, this.key);
  }

  /** Caller must revalidate current auth/device/release state before each issuance; this does not mutate sessions. */
  issueConnection(session: RemoteSession, consent: VerifiedHostConsent, binding: RemoteTransportBinding, now = Date.now()) {
    return this.issue('connection', session, consent, binding, now);
  }
  issueLease(session: RemoteSession, consent: VerifiedHostConsent, binding: RemoteTransportBinding,
    challenge: string, leaseSeq: number, now = Date.now()) {
    return this.issue('lease', session, consent, binding, now, { challenge, leaseSeq });
  }
  private issue(purpose: 'connection' | 'lease', session: RemoteSession, consent: VerifiedHostConsent,
    binding: RemoteTransportBinding, now: number, lease?: { challenge: string; leaseSeq: number }) {
    const local = consent.claims;
    if (!consentAuthority.has(consent) || local.decision === 'reject' || local.sessionId !== session.id
      || !isEndpoint(local.host, session.host) || !isEndpoint(local.controller, session.controller)
      || (session.scope === 'control' && local.decision !== 'control')
      || session.authorizationRevision < local.authorizationRevision || session.controlEpoch < local.controlEpoch
      || (session.scope === 'control' && (session.authorizationRevision !== local.authorizationRevision || session.controlEpoch !== local.controlEpoch))
      || session.state !== (purpose === 'connection' ? 'connecting' : 'active')
      || session.deadline <= now || session.hardDeadline <= now || now < this.publicKey.notBefore
      || now >= this.publicKey.notAfter) return fail();
    const expiresAt = Math.min(now + (purpose === 'connection' ? REMOTE_LIMITS.connectMs : REMOTE_LIMITS.leaseMs),
      session.deadline, session.hardDeadline, this.publicKey.notAfter);
    const transport = transportBindingSchema.parse(binding);
    const claims = credentialSchema.parse({ protocolVersion: 1, issuer: 'todesk-remote-control', audience: 'todesk-remote-peer',
      purpose, sessionId: session.id, host: session.host, controller: session.controller,
      negotiationId: transport.negotiationId, hostFingerprint: transport.hostFingerprint, controllerFingerprint: transport.controllerFingerprint,
      consentNonce: local.consentNonce, screenId: local.screenId, scope: session.scope,
      authorizationRevision: session.authorizationRevision, controlEpoch: session.controlEpoch,
      issuedAt: now, expiresAt, ...lease });
    return signed(this.publicKey.keyId, claims, this.key);
  }
}

/** Explicit deployment keys only; never derive an asymmetric signing key from account JWT secrets. */
export function remoteCredentialSignerFromEnvironment(environment: NodeJS.ProcessEnv = process.env): RemoteCredentialSigner | null {
  const fields = [environment.REMOTE_CONTROL_SIGNING_KEY_ID, environment.REMOTE_CONTROL_SIGNING_PRIVATE_KEY,
    environment.REMOTE_CONTROL_SIGNING_KEY_NOT_BEFORE, environment.REMOTE_CONTROL_SIGNING_KEY_NOT_AFTER];
  if (fields.every(value => !value)) return null;
  if (fields.some(value => !value)) throw new Error('REMOTE_SIGNING_KEY_CONFIGURATION_INCOMPLETE');
  return new RemoteCredentialSigner(fields[0]!, fields[1]!, Number(fields[2]), Number(fields[3]));
}

/** Read-only verification utility used by wire contract tests; no token can supply its own public key. */
export function verifyRemoteCredential(envelope: unknown, trustedKey: RemotePublicSigningKey, now: number): RemoteCredentialClaims {
  const publicBytes = Buffer.from(trustedKey.publicKey, 'base64url');
  if (publicBytes.length !== 32 || publicBytes.toString('base64url') !== trustedKey.publicKey
    || now < trustedKey.notBefore || now >= trustedKey.notAfter) return fail();
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: trustedKey.publicKey }, format: 'jwk' });
  const parsed = credentialSchema.safeParse(decode(envelope, key, trustedKey.keyId));
  if (!parsed.success) return fail();
  const claims = parsed.data;
  if (claims.issuedAt > now || claims.expiresAt <= now || claims.issuedAt < trustedKey.notBefore || claims.expiresAt > trustedKey.notAfter
    || claims.expiresAt - claims.issuedAt > (claims.purpose === 'lease' ? REMOTE_LIMITS.leaseMs : REMOTE_LIMITS.connectMs)) return fail();
  return claims;
}

/** Native requests use a different audience/purpose and can never serve as media authority. */
export function verifyRemoteApproval(envelope: unknown, trustedKey: RemotePublicSigningKey, now: number): RemoteApprovalClaims {
  const publicBytes = Buffer.from(trustedKey.publicKey, 'base64url');
  if (publicBytes.length !== 32 || publicBytes.toString('base64url') !== trustedKey.publicKey
    || now < trustedKey.notBefore || now >= trustedKey.notAfter) return fail();
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: trustedKey.publicKey }, format: 'jwk' });
  const parsed = approvalSchema.safeParse(decode(envelope, key, trustedKey.keyId));
  if (!parsed.success) return fail();
  const claims = parsed.data;
  if (claims.issuedAt > now || claims.expiresAt <= now || claims.issuedAt < trustedKey.notBefore
    || claims.expiresAt > trustedKey.notAfter || claims.expiresAt <= claims.issuedAt
    || claims.expiresAt - claims.issuedAt > REMOTE_LIMITS.requestMs
    || claims.sessionExpiresAt < claims.expiresAt || claims.sessionExpiresAt - claims.issuedAt > REMOTE_LIMITS.sessionMs
    || (claims.action === 'grant-control' && claims.requestedScope !== 'control')) return fail();
  return claims;
}

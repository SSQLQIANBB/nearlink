import { z } from 'zod';
import { decodeRemoteDeviceEvidence } from './remoteCredentials';
import { isEndpoint, RemoteControlError, REMOTE_LIMITS, uuid, type RemoteEndpoint, type RemoteSession } from './remoteControlProtocol';
import type { RemoteAuthorityDevice, RemoteNativeChallenge, RemoteReadyEvidence } from './remoteAuthorizationCoordinator';

const integer = z.number().int().nonnegative().safe();
const nonce = z.string().regex(/^[A-Za-z0-9_-]{43}$/).refine(v => Buffer.from(v, 'base64url').toString('base64url') === v);
const endpoint = z.object({ userId: integer.positive(), sid: uuid, authVersion: uuid, endpointId: uuid,
  connectionId: z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/), generation: integer.positive() }).strict();
const times = { issuedAt: integer, expiresAt: integer.positive() };
const base = { protocolVersion: z.literal(1), host: endpoint, ...times };
const presenceSchema = z.object({ ...base, purpose: z.literal('native-presence'), challenge: nonce,
  platform: z.literal('macos'), engineDigest: z.string().regex(/^[a-f0-9]{64}$/),
  canCapture: z.boolean(), canControl: z.boolean() }).strict();
const factSchema = z.object({ ...base, purpose: z.enum(['native-ready', 'native-lease-challenge']),
  sessionId: uuid, negotiationId: uuid, hostFingerprint: z.string().regex(/^[A-F0-9]{64}$/),
  controllerFingerprint: z.string().regex(/^[A-F0-9]{64}$/), consentNonce: nonce, screenId: z.literal('primary'),
  authorizationRevision: integer.positive(), controlEpoch: integer,
  challenge: nonce.optional(), leaseSeq: integer.positive().optional() }).strict();
export type NativePresence = z.infer<typeof presenceSchema>;
const fail = (): never => { throw new RemoteControlError('INVALID_NATIVE_EVIDENCE', 403); };
function time(value: { issuedAt: number; expiresAt: number }, now: number) {
  if (value.issuedAt > now || value.expiresAt <= now || value.expiresAt <= value.issuedAt
    || value.expiresAt - value.issuedAt > REMOTE_LIMITS.challengeMs) fail();
}
export function verifyNativePresence(envelope: unknown, device: RemoteAuthorityDevice, host: RemoteEndpoint,
  challenge: string, challengeIssuedAt: number, now: number): NativePresence {
  const parsed = presenceSchema.safeParse(decodeRemoteDeviceEvidence(envelope, device));
  if (!parsed.success) return fail();
  const fact = parsed.data; time(fact, now);
  if (!isEndpoint(host, fact.host) || device.id !== host.endpointId || device.ownerUserId !== host.userId
    || fact.challenge !== challenge || fact.issuedAt < challengeIssuedAt
    || fact.expiresAt > challengeIssuedAt + REMOTE_LIMITS.challengeMs || (fact.canControl && !fact.canCapture)) return fail();
  return fact;
}
/** Only native code owning the consent/runtime can produce these device-key signatures. */
export function verifyNativeSessionFact(envelope: unknown, device: RemoteAuthorityDevice, session: RemoteSession, now: number) {
  const parsed = factSchema.safeParse(decodeRemoteDeviceEvidence(envelope, device));
  if (!parsed.success) return fail();
  const fact = parsed.data; time(fact, now);
  if (session.state === 'ended' || Math.min(session.deadline, session.hardDeadline) <= now
    || fact.sessionId !== session.id || !isEndpoint(fact.host, session.host)
    || device.id !== session.host.endpointId || device.ownerUserId !== session.host.userId
    || !((fact.authorizationRevision === session.authorizationRevision && fact.controlEpoch === session.controlEpoch)
      || (fact.purpose === 'native-lease-challenge' && session.scope === 'view'
        && fact.authorizationRevision <= session.authorizationRevision && fact.controlEpoch <= session.controlEpoch))
    || ((fact.purpose === 'native-lease-challenge') !== (fact.challenge !== undefined && fact.leaseSeq !== undefined))
    || (fact.purpose === 'native-ready' && (fact.challenge !== undefined || fact.leaseSeq !== undefined))) return fail();
  return fact;
}
export function readyEvidence(fact: ReturnType<typeof verifyNativeSessionFact>, actor: RemoteEndpoint): RemoteReadyEvidence {
  if (fact.purpose !== 'native-ready') return fail();
  return { sessionId: fact.sessionId, endpoint: actor, negotiationId: fact.negotiationId,
    hostFingerprint: fact.hostFingerprint, controllerFingerprint: fact.controllerFingerprint,
    consentNonce: fact.consentNonce, screenId: fact.screenId,
    authorizationRevision: fact.authorizationRevision, controlEpoch: fact.controlEpoch };
}
export function challengeEvidence(fact: ReturnType<typeof verifyNativeSessionFact>): RemoteNativeChallenge {
  if (fact.purpose !== 'native-lease-challenge' || !fact.challenge || !fact.leaseSeq) return fail();
  return { ...readyEvidence({ ...fact, purpose: 'native-ready' }, fact.host), host: fact.host,
    challenge: fact.challenge, leaseSeq: fact.leaseSeq, issuedAt: fact.issuedAt, expiresAt: fact.expiresAt };
}

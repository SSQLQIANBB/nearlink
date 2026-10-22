export interface RemoteEndpointIdentity {
  userId: number;
  sid: string;
  authVersion: string;
  endpointId: string;
  connectionId: string;
  generation: number;
}
export interface RemotePeerBinding {
  sessionId: string;
  host: RemoteEndpointIdentity;
  controller: RemoteEndpointIdentity;
  negotiationId: string;
  hostFingerprint: string;
  controllerFingerprint: string;
  consentNonce: string;
  screenId: string;
}
export interface RemoteSignedEnvelope {
  format: 'rc-signed-v1';
  keyId: string;
  payload: string;
  signature: string;
}
export interface RemoteSigningKey {
  keyId: string;
  publicKey: string;
  notBefore: number;
  notAfter: number;
}
export interface RemoteProofClaims extends RemotePeerBinding {
  protocolVersion: 1;
  issuer: 'todesk-remote-control';
  audience: 'todesk-remote-peer';
  purpose: 'connection' | 'lease';
  scope: 'view' | 'control';
  authorizationRevision: number;
  controlEpoch: number;
  issuedAt: number;
  expiresAt: number;
  leaseSeq?: number;
  challenge?: string;
}
export interface VerifiedRemoteProof {
  claims: RemoteProofClaims;
  deadline: number;
  envelope: RemoteSignedEnvelope;
}
const bindingFields = [
  'sessionId',
  'negotiationId',
  'hostFingerprint',
  'controllerFingerprint',
  'consentNonce',
  'screenId',
] as const;
const endpointFields = [
  'userId',
  'sid',
  'authVersion',
  'endpointId',
  'connectionId',
  'generation',
] as const;
function decode(value: string, maxBytes: number) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    value.length > Math.ceil((maxBytes * 4) / 3)
  )
    throw new Error('REMOTE_PROOF_ENCODING');
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  if (raw.length > maxBytes) throw new Error('REMOTE_PROOF_SIZE');
  if (btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== value)
    throw new Error('REMOTE_PROOF_ENCODING');
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}
function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
const identifier = (value: unknown) =>
  typeof value === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(value);
const uuid = (value: unknown) =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const exactKeys = (value: object, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
function sameEndpoint(a: RemoteEndpointIdentity, b: RemoteEndpointIdentity) {
  return (
    !!a &&
    !!b &&
    exactKeys(a, endpointFields) &&
    integer(a.userId) &&
    a.userId > 0 &&
    integer(a.generation) &&
    a.generation > 0 &&
    uuid(a.sid) &&
    uuid(a.authVersion) &&
    identifier(a.endpointId) &&
    identifier(a.connectionId) &&
    endpointFields.every((field) => a[field] === b[field])
  );
}

/** The caller supplies keys fetched from the authenticated, fixed application endpoint. */
export async function verifyRemoteProof(
  raw: unknown,
  keys: readonly RemoteSigningKey[],
  binding: RemotePeerBinding,
  purpose: 'connection' | 'lease',
  time = { monotonic: performance.now() },
): Promise<VerifiedRemoteProof> {
  if (!raw || typeof raw !== 'object' || keys.length < 1 || keys.length > 2)
    throw new Error('REMOTE_PROOF_UNTRUSTED');
  const envelope = raw as RemoteSignedEnvelope;
  if (
    envelope.format !== 'rc-signed-v1' ||
    !identifier(envelope.keyId) ||
    !exactKeys(envelope, ['format', 'keyId', 'payload', 'signature'])
  )
    throw new Error('REMOTE_PROOF_FORMAT');
  const key = keys.find((item) => item.keyId === envelope.keyId);
  if (
    !key ||
    !integer(key.notBefore) ||
    !integer(key.notAfter) ||
    key.notAfter <= key.notBefore
  )
    throw new Error('REMOTE_PROOF_KEY');
  const payload = decode(envelope.payload, 12288);
  const signature = decode(envelope.signature, 64);
  const publicKey = decode(key.publicKey, 32);
  if (signature.length !== 64 || publicKey.length !== 32) throw new Error('REMOTE_PROOF_KEY');
  let verified = false;
  try {
    const imported = await crypto.subtle.importKey('raw', publicKey, { name: 'Ed25519' }, false, [
      'verify',
    ]);
    verified = await crypto.subtle.verify(
      { name: 'Ed25519' },
      imported,
      signature,
      new TextEncoder().encode(`todesk-remote-control/v1\n${envelope.keyId}\n${envelope.payload}`),
    );
  } catch {
    throw new Error('REMOTE_SIGNATURE_UNSUPPORTED');
  }
  if (!verified) throw new Error('REMOTE_PROOF_SIGNATURE');
  let claims: RemoteProofClaims;
  try {
    claims = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
  } catch {
    throw new Error('REMOTE_PROOF_PAYLOAD');
  }
  if (
    !claims ||
    typeof claims !== 'object' ||
    !exactKeys(claims, [
      ...bindingFields,
      'host',
      'controller',
      'protocolVersion',
      'issuer',
      'audience',
      'purpose',
      'scope',
      'authorizationRevision',
      'controlEpoch',
      'issuedAt',
      'expiresAt',
      'leaseSeq',
      'challenge',
    ]) ||
    claims.protocolVersion !== 1 ||
    claims.issuer !== 'todesk-remote-control' ||
    claims.audience !== 'todesk-remote-peer' ||
    claims.purpose !== purpose ||
    !['view', 'control'].includes(claims.scope)
  )
    throw new Error('REMOTE_PROOF_PURPOSE');
  if (
    !bindingFields.every(
      (field) =>
        typeof binding[field] === 'string' &&
        binding[field].length > 0 &&
        claims[field] === binding[field],
    ) ||
    !sameEndpoint(claims.host, binding.host) ||
    !sameEndpoint(claims.controller, binding.controller)
  )
    throw new Error('REMOTE_PROOF_BINDING');
  if (
    !uuid(claims.sessionId) ||
    !uuid(claims.negotiationId) ||
    typeof claims.screenId !== 'string' ||
    claims.screenId.length < 1 ||
    claims.screenId.length > 128
  )
    throw new Error('REMOTE_PROOF_BINDING');
  if (
    ![claims.hostFingerprint, claims.controllerFingerprint].every((value) =>
      /^[A-F0-9]{64}$/.test(value),
    ) ||
    decode(claims.consentNonce, 32).length !== 32
  )
    throw new Error('REMOTE_PROOF_BINDING');
  const maxAge = purpose === 'connection' ? 30000 : 15000;
  if (
    ![claims.issuedAt, claims.expiresAt, claims.authorizationRevision, claims.controlEpoch].every(
      integer,
    ) ||
    claims.expiresAt <= claims.issuedAt ||
    claims.expiresAt - claims.issuedAt > maxAge ||
    claims.issuedAt < key.notBefore ||
    claims.expiresAt > key.notAfter ||
    claims.authorizationRevision === 0
  )
    throw new Error('REMOTE_PROOF_EXPIRED');
  if (purpose === 'connection' && ('leaseSeq' in claims || 'challenge' in claims))
    throw new Error('REMOTE_PROOF_CHALLENGE');
  if (
    purpose === 'lease' &&
    (!integer(claims.leaseSeq) ||
      claims.leaseSeq < 1 ||
      typeof claims.challenge !== 'string' ||
      decode(claims.challenge, 32).length !== 32)
  )
    throw new Error('REMOTE_PROOF_CHALLENGE');
  return {
    claims,
    // Server time defines the signed lifetime. The current connection binding
    // and peer's sequence checks prevent replay from renewing local authority.
    // Native independently bounds each lease from its own challenge send time.
    deadline: time.monotonic + (claims.expiresAt - claims.issuedAt),
    envelope: { ...envelope },
  };
}

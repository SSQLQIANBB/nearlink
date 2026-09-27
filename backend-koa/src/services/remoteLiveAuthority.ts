import { randomBytes, randomUUID } from 'crypto';
import type { AuthenticatedSessionPayload } from './loginSessionService';
import { RemoteControlError, isEndpoint, REMOTE_LIMITS, type RemoteEndpoint, type RemoteSession } from './remoteControlProtocol';
import { RemoteCredentialSigner, type RemoteTransportBinding } from './remoteCredentials';
import { verifyNativePresence, verifyNativeSessionFact, readyEvidence, challengeEvidence, type NativePresence } from './remoteNativeEvidence';
import type { RemoteCoordinatorAuthority, RemoteAuthorityDevice, RemoteReadyEvidence, RemoteNativeChallenge } from './remoteAuthorizationCoordinator';

export interface LiveConnection {
  readonly handle: object; readonly endpoint: RemoteEndpoint; readonly role: 'host' | 'controller';
  readonly platform: 'macos' | 'windows' | 'web'; readonly token: string;
  readonly expiresAt: number;
  presence?: NativePresence;
  challenge?: { value: string; issuedAt: number };
}
interface Negotiation { id: string; hostFingerprint?: string; controllerFingerprint?: string; candidates: { host: number; controller: number } }
export interface LiveAuthorityDependencies {
  authenticate(token: string): Promise<AuthenticatedSessionPayload>;
  device(id: string): Promise<RemoteAuthorityDevice | null>;
  released(session: RemoteSession): Promise<void>;
}
const fail = (code: string): never => { throw new RemoteControlError(code, 403); };
/** Single-process, bounded registry. No presence or evidence survives a disconnect/restart. */
export class RemoteLiveAuthority implements RemoteCoordinatorAuthority {
  private readonly connections = new Map<object, LiveConnection>();
  private readonly byId = new Map<string, LiveConnection>();
  private readonly hosts = new Map<string, LiveConnection>();
  private readonly negotiations = new Map<string, Negotiation>();
  private readonly ready = new WeakMap<object, RemoteReadyEvidence>();
  private readonly challenges = new WeakMap<object, RemoteNativeChallenge>();
  constructor(private readonly dependencies: LiveAuthorityDependencies, private readonly signer: RemoteCredentialSigner,
    private readonly now = Date.now, private readonly capacity = 256) {}
  async connect(token: string, id: string, endpointId: string, role: LiveConnection['role'], platform: LiveConnection['platform']) {
    if (this.connections.size >= this.capacity || this.byId.has(id)) return fail('REMOTE_CAPACITY');
    const auth = await this.dependencies.authenticate(token);
    if (this.connections.size >= this.capacity || this.byId.has(id)) return fail('REMOTE_CAPACITY');
    if (role === 'host') {
      const device = await this.dependencies.device(endpointId);
      if (!device || device.revokedAt || device.ownerUserId !== auth.userId) return fail('TARGET_UNAVAILABLE');
      if (this.hosts.has(endpointId)) return fail('DEVICE_ALREADY_ONLINE');
    }
    if (this.connections.size >= this.capacity || this.byId.has(id)) return fail('REMOTE_CAPACITY');
    if (role === 'host' && this.hosts.has(endpointId)) return fail('DEVICE_ALREADY_ONLINE');
    const endpoint = Object.freeze({ userId: auth.userId, sid: auth.sid, authVersion: auth.authVersion,
      endpointId, connectionId: id, generation: 1 });
    const value: LiveConnection = { handle: Object.freeze({}), endpoint, role, platform, token, expiresAt: auth.exp * 1000 };
    this.connections.set(value.handle, value); this.byId.set(id, value);
    if (role === 'host') this.hosts.set(endpointId, value);
    return value;
  }
  disconnect(value: LiveConnection) {
    this.connections.delete(value.handle);
    if (this.byId.get(value.endpoint.connectionId) === value) this.byId.delete(value.endpoint.connectionId);
    if (this.hosts.get(value.endpoint.endpointId) === value) this.hosts.delete(value.endpoint.endpointId);
    value.presence = undefined; value.challenge = undefined;
  }
  private current(value: LiveConnection) {
    if (this.connections.get(value.handle) !== value || this.byId.get(value.endpoint.connectionId) !== value
      || value.expiresAt <= this.now()) return fail('REMOTE_DISCONNECTED');
  }
  async resolveConnection(handle: object) {
    const value = this.connections.get(handle); if (!value) return fail('REMOTE_DISCONNECTED');
    await this.assertCurrent(value.endpoint); return value.endpoint;
  }
  async assertCurrent(endpoint: RemoteEndpoint) {
    const value = this.byId.get(endpoint.connectionId);
    if (!value || !isEndpoint(value.endpoint, endpoint)) return fail('REMOTE_DISCONNECTED');
    this.current(value);
    const auth = await this.dependencies.authenticate(value.token);
    this.current(value);
    if (auth.userId !== endpoint.userId || auth.sid !== endpoint.sid || auth.authVersion !== endpoint.authVersion) return fail('AUTH_REVOKED');
    if (value.role === 'host' && (!value.presence || value.presence.expiresAt <= this.now())) return fail('HOST_OFFLINE');
  }
  async presenceChallenge(value: LiveConnection) {
    this.current(value); if (value.role !== 'host') return fail('HOST_REQUIRED');
    const device = await this.dependencies.device(value.endpoint.endpointId);
    if (!device || device.ownerUserId !== value.endpoint.userId) return fail('TARGET_UNAVAILABLE');
    this.current(value);
    const challenge = { value: randomBytes(32).toString('base64url'), issuedAt: this.now() };
    const proof = this.signer.issuePresenceChallenge(value.endpoint, device, challenge.value, challenge.issuedAt);
    value.challenge = challenge; return proof;
  }
  async acceptPresence(value: LiveConnection, proof: unknown) {
    this.current(value); if (value.role !== 'host' || !value.challenge) return fail('PRESENCE_CHALLENGE_REQUIRED');
    const pending = value.challenge; value.challenge = undefined;
    const device = await this.dependencies.device(value.endpoint.endpointId);
    if (!device) return fail('TARGET_UNAVAILABLE');
    const presence = verifyNativePresence(proof, device, value.endpoint, pending.value, pending.issuedAt, this.now());
    this.current(value); value.presence = presence; return presence;
  }
  host(id: string): LiveConnection | undefined {
    const value = this.hosts.get(id);
    if (!value || !value.presence || value.presence.expiresAt <= this.now() || value.expiresAt <= this.now()) return undefined;
    return value;
  }
  async assertReleased(session: RemoteSession) { await this.dependencies.released(session); }
  async device(session: RemoteSession) {
    const device = await this.dependencies.device(session.host.endpointId);
    if (!device) return fail('TARGET_UNAVAILABLE'); return device;
  }
  beginNegotiation(session: RemoteSession) {
    if (this.negotiations.has(session.id)) return this.negotiations.get(session.id)!.id;
    if (session.state !== 'connecting' || this.negotiations.size >= 128) return fail('NEGOTIATION_UNAVAILABLE');
    const id = randomUUID(); this.negotiations.set(session.id, { id, candidates: { host: 0, controller: 0 } }); return id;
  }
  signal(session: RemoteSession, actor: RemoteEndpoint, negotiationId: string, type: 'offer' | 'answer' | 'candidate', sdp?: string) {
    const negotiation = this.negotiations.get(session.id);
    if (!negotiation || negotiation.id !== negotiationId
      || !(session.state === 'connecting' || (session.state === 'active' && type === 'candidate'))) return fail('NEGOTIATION_MISMATCH');
    const host = isEndpoint(session.host, actor), controller = isEndpoint(session.controller, actor);
    if (!host && !controller) return fail('NOT_A_PARTICIPANT');
    if (type === 'candidate') {
      if (++negotiation.candidates[host ? 'host' : 'controller'] > 128) return fail('CANDIDATE_LIMIT');
      return;
    }
    if ((type === 'offer') !== controller || !sdp || Buffer.byteLength(sdp) > 65536) return fail('SIGNAL_REJECTED');
    const fingerprints = [...sdp.matchAll(/^a=fingerprint:sha-256 ([A-Fa-f0-9:]+)\r?$/gm)].map(m => m[1].replace(/:/g, '').toUpperCase());
    if (!fingerprints.length || fingerprints.some(f => !/^[A-F0-9]{64}$/.test(f) || f !== fingerprints[0])) return fail('SDP_FINGERPRINT_INVALID');
    const key = controller ? 'controllerFingerprint' : 'hostFingerprint';
    if (negotiation[key] || (host && !negotiation.controllerFingerprint)) return fail('SDP_REPLAY');
    negotiation[key] = fingerprints[0];
  }
  async negotiation(session: RemoteSession): Promise<RemoteTransportBinding> {
    const value = this.negotiations.get(session.id);
    if (!value?.hostFingerprint || !value.controllerFingerprint) return fail('NEGOTIATION_INCOMPLETE');
    return { negotiationId: value.id, hostFingerprint: value.hostFingerprint, controllerFingerprint: value.controllerFingerprint };
  }
  async nativeFact(session: RemoteSession, connection: LiveConnection, proof: unknown) {
    await this.assertCurrent(connection.endpoint);
    if (!isEndpoint(connection.endpoint, session.host)) return fail('HOST_REQUIRED');
    const fact = verifyNativeSessionFact(proof, await this.device(session), session, this.now());
    const binding = await this.negotiation(session);
    if (fact.negotiationId !== binding.negotiationId || fact.hostFingerprint !== binding.hostFingerprint
      || fact.controllerFingerprint !== binding.controllerFingerprint) return fail('TRANSPORT_BINDING_CHANGED');
    const handle = Object.freeze({});
    if (fact.purpose === 'native-ready') {
      const controllerHandle = Object.freeze({});
      this.ready.set(handle, readyEvidence(fact, session.host));
      // Native hello verifies the controller's proof on the actual authenticated DataChannel.
      this.ready.set(controllerHandle, readyEvidence(fact, session.controller));
      return { type: 'ready' as const, handle, controllerHandle };
    }
    this.challenges.set(handle, challengeEvidence(fact)); return { type: 'challenge' as const, handle };
  }
  async consumeReady(handle: object) {
    const value = this.ready.get(handle); this.ready.delete(handle);
    if (!value) return fail('READY_EVIDENCE_REQUIRED'); return value;
  }
  async consumeNativeChallenge(handle: object) {
    const value = this.challenges.get(handle); this.challenges.delete(handle);
    if (!value) return fail('NATIVE_CHALLENGE_REQUIRED'); return value;
  }
  connection(endpoint: RemoteEndpoint) {
    const value = this.byId.get(endpoint.connectionId);
    if (!value || !isEndpoint(value.endpoint, endpoint)) return fail('REMOTE_DISCONNECTED'); return value;
  }
  forget(sessionId: string) { this.negotiations.delete(sessionId); }
}

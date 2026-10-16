import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'crypto';
import { isEndpoint, REMOTE_LIMITS, RemoteControlError, type RemoteEndpoint, type RemoteScope, type RemoteSession } from './remoteControlProtocol';

interface Credentials {
  host: RemoteEndpoint;
  online: boolean;
  code: string;
  digest: Buffer;
  version: string;
}
interface Admission {
  id: string;
  requestId: string;
  host: RemoteEndpoint;
  controller: RemoteEndpoint;
  scope: RemoteScope;
  version: string;
  expiresAt: number;
}

/** Password digests survive a host toggle; an authenticated online binding is still required. */
export class RemoteDeviceCodes {
  private readonly secret = randomBytes(32);
  private readonly credentials = new Map<string, Credentials>();
  private readonly admissions = new Map<string, Admission>();
  private readonly attempts = new Map<string, { count: number; until: number }>();
  constructor(private readonly now = Date.now) {}

  private digest(code: string, password: string) {
    return createHmac('sha256', this.secret).update(`${code}\n${password}`).digest();
  }
  private limit(key: string, maximum: number) {
    const now = this.now();
    for (const [id, item] of this.attempts) if (item.until <= now) this.attempts.delete(id);
    const item = this.attempts.get(key) || { count: 0, until: now + 60_000 };
    if (item.count >= maximum || (!this.attempts.has(key) && this.attempts.size >= 1024))
      throw new RemoteControlError('REMOTE_CODE_RATE_LIMITED', 429);
    item.count++;
    this.attempts.set(key, item);
  }
  issue(host: RemoteEndpoint, code: string, resume?: { deviceCode: string; temporaryPassword: string }) {
    this.limit(`issue:${host.userId}`, 6);
    const previous = this.credentials.get(host.endpointId);
    if (resume) {
      if (!previous || previous.host.userId !== host.userId || previous.code !== resume.deviceCode || previous.code !== code ||
          !timingSafeEqual(previous.digest, this.digest(resume.deviceCode, resume.temporaryPassword)))
        throw new RemoteControlError('REMOTE_CODE_INVALID', 403);
      previous.host = host;
      previous.online = true;
      return resume;
    }
    if (!previous && this.credentials.size >= 256)
      throw new RemoteControlError('REMOTE_CAPACITY', 503);
    const alphabet = '23456789abcdefghjkmnpqrstuvwxyz';
    const password = Array.from({ length: 10 }, () => alphabet[randomInt(alphabet.length)]).join('');
    this.credentials.set(host.endpointId, {
      host, online: true, code, digest: this.digest(code, password), version: randomUUID(),
    });
    return { deviceCode: code, temporaryPassword: password };
  }
  authorize(code: string, password: string, controller: RemoteEndpoint, requestId: string, scope: RemoteScope) {
    this.limit(`actor:${controller.userId}`, 10);
    this.limit(`code:${code}`, 10);
    const item = [...this.credentials.values()].find((value) => value.code === code);
    const digest = this.digest(code, password);
    if (!item || !item.online || !timingSafeEqual(item.digest, digest))
      throw new RemoteControlError('REMOTE_CODE_INVALID', 403);
    if (item.host.endpointId === controller.endpointId)
      throw new RemoteControlError('SELF_CONTROL_NOT_ALLOWED');
    for (const [id, admission] of this.admissions)
      if (admission.expiresAt <= this.now()) this.admissions.delete(id);
    const prior = [...this.admissions.values()].find((value) =>
      value.requestId === requestId && isEndpoint(value.controller, controller));
    if (prior) {
      if (!isEndpoint(prior.host, item.host) || prior.scope !== scope || prior.version !== item.version)
        throw new RemoteControlError('IDEMPOTENCY_CONFLICT');
      return prior;
    }
    if (this.admissions.size >= 256) throw new RemoteControlError('REMOTE_CAPACITY', 503);
    const admission: Admission = {
      id: randomUUID(), requestId, host: item.host, controller, scope,
      version: item.version, expiresAt: this.now() + REMOTE_LIMITS.requestMs,
    };
    this.admissions.set(admission.id, admission);
    return admission;
  }
  assertAuthorized(session: RemoteSession) {
    const admission = this.admissions.get(session.grantId);
    const credentials = this.credentials.get(session.host.endpointId);
    if (!admission || !credentials?.online || !isEndpoint(credentials.host, session.host) || admission.expiresAt <= this.now() ||
        admission.requestId !== session.requestId || admission.scope !== session.requestedScope ||
        !isEndpoint(admission.host, session.host) || !isEndpoint(admission.controller, session.controller) ||
        (session.state === 'pending' && admission.version !== credentials.version))
      throw new RemoteControlError('REMOTE_CODE_AUTHORIZATION_EXPIRED', 403);
    if (session.state !== 'pending') admission.expiresAt = session.hardDeadline;
  }
  forget(id: string) { this.admissions.delete(id); }
  disconnect(endpoint: RemoteEndpoint) {
    const credentials = this.credentials.get(endpoint.endpointId);
    if (credentials && isEndpoint(credentials.host, endpoint)) credentials.online = false;
    for (const [id, value] of this.admissions)
      if (isEndpoint(value.host, endpoint) || isEndpoint(value.controller, endpoint)) this.admissions.delete(id);
  }
}

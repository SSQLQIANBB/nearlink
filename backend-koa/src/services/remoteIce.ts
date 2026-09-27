import { createHmac } from 'crypto';
import { z } from 'zod';
import { REMOTE_LIMITS, RemoteControlError, isEndpoint, uuid, type RemoteEndpoint, type RemoteSession } from './remoteControlProtocol';
import type { RemoteCredentialSigner } from './remoteCredentials';

export const TURN_GRACE_MS = 5 * 60_000;
const turnUrl = z.string().max(512).regex(/^(?:stun:[a-zA-Z0-9.-]+:[0-9]{1,5}|turns?:[a-zA-Z0-9.-]+:[0-9]{1,5}\?transport=(?:udp|tcp))$/)
  .refine(value => {
    const port = Number(value.match(/:(\d+)(?:\?|$)/)?.[1]);
    const host = value.split(':')[1]!;
    return port > 0 && port <= 65535 && (!value.startsWith('turns:') || value.endsWith('?transport=tcp'))
      && host.length <= 253 && host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
  });
export const iceServerSchema = z.object({ urls: z.array(turnUrl).min(1).max(4),
  username: z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/).optional(),
  credential: z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/).optional(),
}).strict().superRefine((server, ctx) => {
  const turn = server.urls.some(url => url.startsWith('turn'));
  if (turn !== !!server.username || turn !== !!server.credential || (turn && server.urls.some(url => url.startsWith('stun:'))))
    ctx.addIssue({ code: 'custom', message: 'INVALID_ICE_SERVER' });
});
export const iceConfigurationSchema = z.object({ iceServers: z.array(iceServerSchema).min(1).max(4),
  iceTransportPolicy: z.enum(['all', 'relay']), expiresAt: z.number().int().positive().safe(),
}).strict().refine(value => value.iceServers.some(server => server.urls.some(url => url.startsWith('turn'))));
export type RemoteIceConfiguration = z.infer<typeof iceConfigurationSchema>;
export type IceAuth = Pick<RemoteEndpoint, 'userId' | 'sid' | 'authVersion'>;
export type TurnSettings = { urls: string[]; stunUrl?: string; policy: 'all' | 'relay' } & (
  { authMode?: 'rest'; secret: string } | { authMode: 'static'; username: string; credential: string }
);

/** Static compatibility is explicit deployment configuration, never an automatic fallback. */
export function turnSettingsFromEnvironment(env: NodeJS.ProcessEnv = process.env): TurnSettings {
  const authMode = env.REMOTE_TURN_AUTH_MODE || 'rest';
  if (!['rest', 'static'].includes(authMode)) throw new RemoteControlError('REMOTE_ICE_CONFIGURATION_INVALID', 503);
  const secret = env.REMOTE_TURN_SHARED_SECRET;
  if (authMode === 'rest' && (!secret || secret.length < 32 || secret.length > 1024 || secret.startsWith('change-me') || /[\r\n\0]/.test(secret)))
    throw new RemoteControlError('REMOTE_ICE_UNCONFIGURED', 503);
  const username = env.REMOTE_TURN_USERNAME, credential = env.REMOTE_TURN_PASSWORD;
  if (authMode === 'static' && (!username || !credential || !/^[\x21-\x7e]{1,256}$/.test(username) || !/^[\x21-\x7e]{1,256}$/.test(credential)))
    throw new RemoteControlError('REMOTE_ICE_UNCONFIGURED', 503);
  const urls = (env.REMOTE_TURN_URLS || 'turn:turn.sycsq.top:3478?transport=udp,turn:turn.sycsq.top:3478?transport=tcp').split(',').map(url => url.trim());
  const stunUrl = env.REMOTE_STUN_URL === '' ? undefined : (env.REMOTE_STUN_URL || 'stun:turn.sycsq.top:3478');
  const policy = env.REMOTE_ICE_TRANSPORT_POLICY || 'all';
  if (!['all', 'relay'].includes(policy) || urls.length < 1 || urls.length > 4 || new Set(urls).size !== urls.length
    || urls.some(url => !turnUrl.safeParse(url).success || !url.startsWith('turn'))
    || (stunUrl && (!turnUrl.safeParse(stunUrl).success || !stunUrl.startsWith('stun:'))))
    throw new RemoteControlError('REMOTE_ICE_CONFIGURATION_INVALID', 503);
  const common = { urls, stunUrl, policy: policy as 'all' | 'relay' };
  return authMode === 'static' ? { ...common, authMode, username: username!, credential: credential! }
    : { ...common, secret: secret! };
}

export class RemoteIceService {
  constructor(private readonly store: { get(id: string): Promise<RemoteSession | null> },
    private readonly authority: { assertAuthorized(session: RemoteSession): Promise<void> },
    private readonly settings: () => TurnSettings,
    private readonly signer: () => RemoteCredentialSigner | null,
    private readonly now: () => number = Date.now) {}

  private participant(session: RemoteSession | null, auth: IceAuth) {
    if (!session) throw new RemoteControlError('SESSION_NOT_FOUND', 404);
    const endpoint = [session.host, session.controller].find(e => e.userId === auth.userId && e.sid === auth.sid && e.authVersion === auth.authVersion);
    if (!endpoint) throw new RemoteControlError('NOT_A_PARTICIPANT', 403);
    const now = this.now();
    if (!['connecting', 'active'].includes(session.state) || session.authorizationRevision < 1
      || session.deadline <= now || session.hardDeadline <= now || session.hardDeadline > now + REMOTE_LIMITS.sessionMs)
      throw new RemoteControlError('REMOTE_ICE_SESSION_UNAVAILABLE', 409);
    return endpoint;
  }
  async issue(id: string, auth: IceAuth) {
    uuid.parse(id);
    const session = await this.store.get(id);
    const endpoint = this.participant(session, auth);
    await this.authority.assertAuthorized(session!);
    // Re-read after durable auth checks; do not issue for an ended/replaced session.
    const current = await this.store.get(id);
    const latestEndpoint = this.participant(current, auth);
    if (current!.revision !== session!.revision || current!.hardDeadline !== session!.hardDeadline
      || !isEndpoint(endpoint, latestEndpoint) || !isEndpoint(current!.host, session!.host) || !isEndpoint(current!.controller, session!.controller))
      throw new RemoteControlError('REVISION_CONFLICT', 409);
    const settings = this.settings(), signer = this.signer();
    if (!signer) throw new RemoteControlError('REMOTE_SIGNING_UNAVAILABLE', 503);
    // Fixed signed configuration expiry; static TURN passwords themselves do not expire.
    // Neither TURN mode supplies consent or replaces the native 15-second lease.
    const expiresAt = Math.floor((current!.hardDeadline + TURN_GRACE_MS) / 1000) * 1000;
    let username: string, credential: string;
    if (settings.authMode === 'static') {
      ({ username, credential } = settings);
    } else {
      const opaque = createHmac('sha256', settings.secret).update(`todesk-turn/v1\n${id}\n${endpoint.endpointId}\n${endpoint.connectionId}\n${endpoint.generation}`).digest('hex').slice(0, 32);
      username = `${expiresAt / 1000}:rc:${opaque}`;
      credential = createHmac('sha1', settings.secret).update(username).digest('base64');
    }
    const config = iceConfigurationSchema.parse({ iceServers: [
      ...(settings.stunUrl && settings.policy === 'all' ? [{ urls: [settings.stunUrl] }] : []),
      { urls: settings.urls, username, credential },
    ], iceTransportPolicy: settings.policy, expiresAt });
    const proof = signer.issueIceConfiguration(current!, config, this.now());
    return { ...config, proof };
  }
}

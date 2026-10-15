import type { RemoteSignedEnvelope } from './remoteControlProof';

export interface RemoteIceConfiguration {
  iceServers: RTCIceServer[];
  iceTransportPolicy: RTCIceTransportPolicy;
  expiresAt: number;
  proof: RemoteSignedEnvelope;
}

/** The fixed authenticated API is the browser's source; native independently verifies proof. */
export function validateRemoteIceConfiguration(
  value: RemoteIceConfiguration,
  sessionDeadline: number,
  now = Date.now(),
): void {
  const fail = () => {
    throw new Error('REMOTE_ICE_CONFIGURATION');
  };
  if (
    !value ||
    !Number.isSafeInteger(sessionDeadline) ||
    sessionDeadline <= now ||
    sessionDeadline > now + 3_600_000 ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= sessionDeadline ||
    value.expiresAt > sessionDeadline + 300_000 ||
    !['all', 'relay'].includes(value.iceTransportPolicy) ||
    !Array.isArray(value.iceServers) ||
    value.iceServers.length > 4
  )
    fail();
  let hasTurn = false;
  for (const server of value.iceServers) {
    if (
      !server ||
      !Array.isArray(server.urls) ||
      server.urls.length < 1 ||
      server.urls.length > 4 ||
      Object.keys(server).some((key) => !['urls', 'username', 'credential'].includes(key))
    )
      fail();
    const urls = server.urls as string[];
    const turn = urls[0]?.startsWith('turn');
    for (const url of urls) {
      const m =
        typeof url === 'string' && url.length <= 512
          ? /^(stun|turn|turns):([a-zA-Z0-9.-]+):([0-9]{1,5})(?:\?transport=(udp|tcp))?$/.exec(url)
          : null;
      if (
        !m ||
        Number(m[3]) < 1 ||
        Number(m[3]) > 65535 ||
        m[2]!.length > 253 ||
        m[2]!.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ||
        (m[1] === 'stun' ? !!m[4] : !m[4]) ||
        (m[1] === 'turns' && m[4] !== 'tcp') ||
        url.startsWith('turn') !== turn
      )
        fail();
    }
    if (turn) {
      if (
        ![server.username, server.credential].every(
          (v) => typeof v === 'string' && /^[\x21-\x7e]{1,256}$/.test(v),
        )
      )
        fail();
      hasTurn = true;
    } else if (server.username !== undefined || server.credential !== undefined) fail();
  }
  if (value.iceTransportPolicy === 'relay' && !hasTurn) fail();
}

// Native libnice consumes numeric addresses. Browser mDNS host names are skipped;
// numeric srflx/relay candidates still provide connectivity without name resolution.
export function isMdnsCandidate(candidate: string): boolean {
  const parts = candidate.trim().split(/\s+/);
  return parts[6] === 'typ' && parts[7] === 'host' && !!parts[4]?.toLowerCase().endsWith('.local');
}
export function withoutMdnsCandidates(sdp: string): string {
  return sdp
    .split('\r\n')
    .filter((line) => !line.startsWith('a=candidate:') || !isMdnsCandidate(line.slice(2)))
    .join('\r\n');
}

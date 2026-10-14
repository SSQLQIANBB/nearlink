import { describe, expect, it } from 'vitest';
import {
  isMdnsCandidate,
  withoutMdnsCandidates,
  validateRemoteIceConfiguration,
  type RemoteIceConfiguration,
} from '@/services/remoteControlIce';
const config = (): RemoteIceConfiguration => ({
  iceServers: [
    {
      urls: ['turn:turn.example.com:3478?transport=udp'],
      username: 'temporary',
      credential: 'test-only',
    },
  ],
  iceTransportPolicy: 'relay',
  expiresAt: 360000,
  proof: { format: 'rc-signed-v1', keyId: 'test', payload: 'test', signature: 'test' },
});
describe('远控ICE配置', () => {
  it('接受覆盖会话寿命的配置，拒绝过短、超期及固定密码URL', () => {
    expect(() => validateRemoteIceConfiguration(config(), 60000, 0)).not.toThrow();
    for (const expiresAt of [60000, 360001, NaN])
      expect(() => validateRemoteIceConfiguration({ ...config(), expiresAt }, 60000, 0)).toThrow();
    for (const url of [
      'turn:user:pass@host:3478?transport=udp',
      'turn:host:0?transport=udp',
      'turns:host:5349?transport=udp',
      'turn:bad..host:3478?transport=tcp',
    ]) {
      const c = config();
      c.iceServers[0]!.urls = [url];
      expect(() => validateRemoteIceConfiguration(c, 60000, 0)).toThrow();
    }
    expect(() =>
      validateRemoteIceConfiguration({ ...config(), iceServers: [] }, 60000, 0),
    ).toThrow();
    expect(() =>
      validateRemoteIceConfiguration(
        { ...config(), iceServers: [{ urls: ['stun:host:3478'] }] },
        60000,
        0,
      ),
    ).toThrow();
  });
  it('mDNS host候选不发给原生，保留数字host、srflx、relay和SDP指纹', () => {
    const mdns = 'candidate:1 1 udp 123 device.local 5000 typ host';
    const relay = 'candidate:2 1 udp 123 203.0.113.3 5000 typ relay raddr 0.0.0.0 rport 0';
    expect(isMdnsCandidate(mdns)).toBe(true);
    expect(isMdnsCandidate(relay)).toBe(false);
    const sdp = `v=0\r\na=fingerprint:sha-256 AA:BB\r\na=${mdns}\r\na=${relay}\r\n`;
    expect(withoutMdnsCandidates(sdp)).toBe(`v=0\r\na=fingerprint:sha-256 AA:BB\r\na=${relay}\r\n`);
  });
});

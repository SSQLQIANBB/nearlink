import { describe, expect, it } from 'vitest';
import { RemoteDeviceCodes } from '../../../src/services/remoteDeviceCodes';
import type { RemoteEndpoint, RemoteSession } from '../../../src/services/remoteControlProtocol';

const endpoint = (id: string): RemoteEndpoint => ({ userId: id === 'host' ? 1 : 2,
  sid: id, authVersion: id, endpointId: id, connectionId: id, generation: 1 });
const host = endpoint('host'), controller = endpoint('controller');
function request(codes: RemoteDeviceCodes, credentials: ReturnType<RemoteDeviceCodes['issue']>) {
  const admission = codes.authorize(credentials.deviceCode, credentials.temporaryPassword, controller, 'request', 'control');
  return { grantId: admission.id, requestId: 'request', requestedScope: 'control',
    host, controller, state: 'pending', hardDeadline: Date.now() + 3600000 } as RemoteSession;
}
describe('device-code request authorization', () => {
  it('rejects incorrect passwords without creating a permanent grant', () => {
    const codes = new RemoteDeviceCodes(), credentials = codes.issue(host);
    expect(() => codes.authorize(credentials.deviceCode, 'zzzzzzzzzz', controller, 'request', 'control')).toThrow('REMOTE_CODE_INVALID');
    const session = request(codes, credentials);
    expect(() => codes.assertAuthorized(session)).not.toThrow();
    expect(JSON.stringify(codes)).not.toContain(credentials.temporaryPassword);
  });
  it('refresh invalidates pending requests but preserves an already confirmed session', () => {
    const codes = new RemoteDeviceCodes(), session = request(codes, codes.issue(host));
    codes.issue(host);
    expect(() => codes.assertAuthorized(session)).toThrow('REMOTE_CODE_AUTHORIZATION_EXPIRED');
    const activeCodes = new RemoteDeviceCodes(), active = request(activeCodes, activeCodes.issue(host));
    active.state = 'active';
    activeCodes.assertAuthorized(active);
    activeCodes.issue(host);
    expect(() => activeCodes.assertAuthorized(active)).not.toThrow();
    activeCodes.disconnect(host);
    expect(() => activeCodes.assertAuthorized(active)).toThrow('REMOTE_CODE_AUTHORIZATION_EXPIRED');
  });
  it('expires credentials and limits retries by account across connections', () => {
    let now = 1000;
    const codes = new RemoteDeviceCodes(() => now), credentials = codes.issue(host);
    now += 900001;
    expect(() => request(codes, credentials)).toThrow('REMOTE_CODE_INVALID');
    const fresh = codes.issue(host);
    for (let i = 0; i < 9; i++) expect(() => codes.authorize(fresh.deviceCode, 'zzzzzzzzzz',
      { ...controller, connectionId: String(i) }, 'request', 'view')).toThrow('REMOTE_CODE_INVALID');
    expect(() => request(codes, fresh)).toThrow('REMOTE_CODE_RATE_LIMITED');
  });
});

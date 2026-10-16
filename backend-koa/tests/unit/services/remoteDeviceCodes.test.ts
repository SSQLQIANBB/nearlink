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
    const codes = new RemoteDeviceCodes(), credentials = codes.issue(host, '123456789');
    expect(() => codes.authorize(credentials.deviceCode, 'zzzzzzzzzz', controller, 'request', 'control')).toThrow('REMOTE_CODE_INVALID');
    const session = request(codes, credentials);
    expect(() => codes.assertAuthorized(session)).not.toThrow();
    expect(JSON.stringify(codes)).not.toContain(credentials.temporaryPassword);
  });
  it('rejects offline codes, resumes only for the same device and rotates on a new runtime', () => {
    const codes = new RemoteDeviceCodes(), credentials = codes.issue(host, '123456789');
    codes.disconnect(host);
    expect(() => request(codes, credentials)).toThrow('REMOTE_CODE_INVALID');
    const reopened = { ...host, connectionId: 'reopened' };
    expect(() => codes.issue({ ...reopened, endpointId: 'another-device' }, '987654321', credentials)).toThrow('REMOTE_CODE_INVALID');
    expect(codes.issue(reopened, '123456789', credentials)).toEqual(credentials);
    expect(() => codes.authorize(credentials.deviceCode, credentials.temporaryPassword, controller, 'next', 'view')).not.toThrow();
    codes.disconnect(host); // A late disconnect from the old socket must not disable the new binding.
    expect(() => codes.authorize(credentials.deviceCode, credentials.temporaryPassword, controller, 'later', 'view')).not.toThrow();
    const next = codes.issue(reopened, '123456789');
    expect(next.temporaryPassword).not.toBe(credentials.temporaryPassword);
    expect(() => request(codes, credentials)).toThrow('REMOTE_CODE_INVALID');
  });
  it('refresh invalidates pending requests but preserves an already confirmed session', () => {
    const codes = new RemoteDeviceCodes(), session = request(codes, codes.issue(host, '123456789'));
    codes.issue(host, '123456789');
    expect(() => codes.assertAuthorized(session)).toThrow('REMOTE_CODE_AUTHORIZATION_EXPIRED');
    const activeCodes = new RemoteDeviceCodes(), active = request(activeCodes, activeCodes.issue(host, '123456789'));
    active.state = 'active';
    activeCodes.assertAuthorized(active);
    activeCodes.issue(host, '123456789');
    expect(() => activeCodes.assertAuthorized(active)).not.toThrow();
    activeCodes.disconnect(host);
    expect(() => activeCodes.assertAuthorized(active)).toThrow('REMOTE_CODE_AUTHORIZATION_EXPIRED');
  });
  it('keeps credentials beyond 15 minutes, rotates manually and limits retries', () => {
    let now = 1000;
    const codes = new RemoteDeviceCodes(() => now), credentials = codes.issue(host, '123456789');
    now += 900001;
    expect(() => request(codes, credentials)).not.toThrow();
    now += 60_001;
    const fresh = codes.issue(host, '123456789');
    expect(fresh.deviceCode).toBe(credentials.deviceCode);
    expect(() => request(codes, credentials)).toThrow('REMOTE_CODE_INVALID');
    for (let i = 0; i < 9; i++) expect(() => codes.authorize(fresh.deviceCode, 'zzzzzzzzzz',
      { ...controller, connectionId: String(i) }, 'request', 'view')).toThrow('REMOTE_CODE_INVALID');
    expect(() => request(codes, fresh)).toThrow('REMOTE_CODE_RATE_LIMITED');
  });
});

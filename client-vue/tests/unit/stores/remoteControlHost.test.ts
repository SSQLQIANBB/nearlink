import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
const mock = vi.hoisted(() => ({ desktop: true, invoke: vi.fn(), io: vi.fn(), release: vi.fn(), ice: vi.fn(), consent: vi.fn(),
  auth: { token: 'test-token' }, channels: [] as any[], cleanups: [] as Array<() => void>, claims: [] as any[] }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => mock.desktop, invoke: mock.invoke,
  Channel: class { onmessage: any; constructor() { mock.channels.push(this); } } }));
vi.mock('socket.io-client', () => ({ io: mock.io }));
vi.mock('@/api/remoteControl', () => ({ getRemoteControlRelease: mock.release, getRemoteSessionIce: mock.ice }));
vi.mock('@/services/remoteControlIce', () => ({ validateRemoteIceConfiguration: vi.fn() }));
vi.mock('@/services/remoteDeviceNative', () => ({ confirmRemoteNativeRequest: mock.consent }));
vi.mock('@/services/remoteControlSafety', () => ({ registerRemoteControlCleanup: (fn: () => void) => mock.cleanups.push(fn) }));
vi.mock('@/services/mediaOccupancy', () => ({ mediaOccupancy: { acquire: () => { const claim = { release: vi.fn() }; mock.claims.push(claim); return claim; } } }));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => mock.auth }));
import { useRemoteControlHostStore } from '@/stores/remoteControlHost';
const id = '11111111-1111-4111-8111-111111111111', device = '22222222-2222-4222-8222-222222222222';
class FakeSocket {
  connected = false; id = 'host-socket'; handlers = new Map<string, Function>();
  on(event: string, callback: Function) { this.handlers.set(event, callback); return this; }
  connect() { this.connected = true; }
  disconnect = vi.fn(() => { this.connected = false; });
  removeAllListeners() { this.handlers.clear(); }
  timeout() { return this; }
  emitWithAck = vi.fn(async (event: string) => event === 'remote:presence' ? { ok: true } : { ok: true, sessionId: id, revision: 1 });
  receive(event: string, value: unknown) { this.handlers.get(event)?.(value); }
}
let socket: FakeSocket;
const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
beforeEach(() => {
  setActivePinia(createPinia()); vi.clearAllMocks(); mock.desktop = true; mock.channels.length = 0; mock.cleanups.length = 0; mock.claims.length = 0;
  socket = new FakeSocket(); mock.io.mockReturnValue(socket); mock.invoke.mockResolvedValue({ format: 'native-proof' });
  mock.release.mockResolvedValue({ desktopHostEnabled: true, releasedPlatforms: ['macos'] });
  mock.ice.mockResolvedValue({ proof: { signed: 'ice' } });
});
afterEach(async () => { for (const cleanup of mock.cleanups) cleanup(); await flush(); });
describe('desktop host bridge lifecycle', () => {
  it('never opens a host socket from Web or when server release is closed', async () => {
    const store = useRemoteControlHostStore(); mock.desktop = false; await store.start(device); expect(mock.io).not.toHaveBeenCalled();
    mock.desktop = true; mock.release.mockResolvedValue({ desktopHostEnabled: false, releasedPlatforms: [] });
    await store.start(device); expect(mock.io).not.toHaveBeenCalled(); expect(store.phase).toBe('offline');
  });
  it('announces online only after native signed presence is acknowledged, without starting capture', async () => {
    const store = useRemoteControlHostStore(); await store.start(device); expect(store.phase).toBe('starting');
    socket.receive('remote:presence-challenge', { proof: { challenge: 'signed' } }); await flush();
    expect(mock.invoke).toHaveBeenCalledWith('remote_control_presence', { proof: { challenge: 'signed' } });
    expect(socket.emitWithAck).toHaveBeenCalledWith('remote:presence', { proof: { format: 'native-proof' } });
    expect(store.phase).toBe('online'); expect(mock.invoke.mock.calls.some(c => c[0] === 'remote_control_start_host')).toBe(false);
  });
  it('stopping during native consent aborts it and ignores a late approval', async () => {
    let confirm!: (proof: unknown) => void;
    mock.consent.mockReturnValue(new Promise(resolve => { confirm = resolve; }));
    const store = useRemoteControlHostStore(); await store.start(device);
    socket.receive('remote:approval', { sessionId: id, state: 'pending', revision: 0, scope: 'view', authorizationRevision: 0, controlEpoch: 0, proof: {} });
    expect(store.phase).toBe('pending'); const signal = mock.consent.mock.calls[0]![1] as AbortSignal;
    store.stop(); expect(signal.aborted).toBe(true); confirm({ signed: 'late-consent' }); await flush();
    expect(socket.emitWithAck).not.toHaveBeenCalled(); expect(mock.claims[0].release).toHaveBeenCalled();
    expect(mock.invoke).toHaveBeenCalledWith('remote_control_stop'); expect(store.phase).toBe('offline');
  });
  it('explains consent timeout and stops without starting media', async () => {
    mock.consent.mockRejectedValue(new Error('REMOTE_NATIVE_TIMEOUT'));
    const store = useRemoteControlHostStore(); await store.start(device);
    socket.receive('remote:approval', { sessionId: id, state: 'pending', revision: 0, scope: 'view', authorizationRevision: 0, controlEpoch: 0, proof: {} });
    await flush();
    expect(store.phase).toBe('offline'); expect(store.error).toContain('45 秒');
    expect(socket.disconnect).toHaveBeenCalled();
    expect(mock.ice).not.toHaveBeenCalled();
    expect(mock.invoke).toHaveBeenCalledWith('remote_control_stop');
    expect(mock.invoke.mock.calls.some(c => c[0] === 'remote_control_start_host')).toBe(false);
  });
  it('disconnect during an ICE fetch cannot launch capture afterward', async () => {
    mock.consent.mockResolvedValue({ signed: 'consent' }); let resolveIce!: (value: unknown) => void;
    mock.ice.mockReturnValue(new Promise(resolve => { resolveIce = resolve; }));
    const store = useRemoteControlHostStore(); await store.start(device);
    socket.receive('remote:approval', { sessionId: id, state: 'pending', revision: 0, scope: 'view', authorizationRevision: 0, controlEpoch: 0, proof: {} }); await flush();
    const endpoint = { userId: 1, sid: id, authVersion: id, endpointId: device, connectionId: 'host-socket', generation: 1 };
    socket.receive('remote:connecting', { sessionId: id, revision: 1, scope: 'view', authorizationRevision: 1, controlEpoch: 1,
      host: endpoint, controller: { ...endpoint, userId: 2, endpointId: id, connectionId: 'controller-socket' },
      consentNonce: 'A'.repeat(43), screenId: 'primary', negotiationId: id, hardDeadline: Date.now() + 3600000 });
    await flush(); expect(mock.ice).toHaveBeenCalled(); socket.receive('disconnect', undefined);
    resolveIce({ proof: { signed: 'ice' } }); await flush();
    expect(mock.invoke.mock.calls.some(c => c[0] === 'remote_control_start_host')).toBe(false);
  });
  it('a failed native stop prevents a new online connection', async () => {
    const store = useRemoteControlHostStore(); await store.start(device);
    mock.invoke.mockRejectedValue(new Error('native unavailable')); store.stop(); await flush();
    const count = mock.io.mock.calls.length; await store.start(device);
    expect(mock.io).toHaveBeenCalledTimes(count); expect(store.phase).toBe('offline');
  });
  it.each(['REMOTE_CONNECT_TIMEOUT', 'private diagnostic /secret/token'])('reports only safe native end codes: %s', async reason => {
    mock.consent.mockResolvedValue({ signed: 'consent' });
    const store = useRemoteControlHostStore(); await store.start(device);
    socket.receive('remote:approval', { sessionId: id, state: 'pending', revision: 0, scope: 'view', authorizationRevision: 0, controlEpoch: 0, proof: {} });
    await flush();
    const endpoint = { userId: 1, sid: id, authVersion: id, endpointId: device, connectionId: 'host-socket', generation: 1 };
    socket.receive('remote:connecting', { sessionId: id, revision: 1, scope: 'view', authorizationRevision: 1, controlEpoch: 1,
      host: endpoint, controller: { ...endpoint, userId: 2, endpointId: id, connectionId: 'controller-socket' },
      consentNonce: 'A'.repeat(43), screenId: 'primary', negotiationId: id, hardDeadline: Date.now() + 3600000 });
    await flush();
    expect(mock.channels).toHaveLength(1);
    mock.channels[0].onmessage({ sessionId: id, type: 'ended', payload: { reason } }); await flush();
    expect(store.phase).toBe('offline'); expect(socket.disconnect).toHaveBeenCalled();
    expect(mock.invoke).toHaveBeenCalledWith('remote_control_stop');
    expect(store.error).toBe(reason.startsWith('REMOTE_') ? `本机远控已停止。（${reason}）` : '本机远控已停止。');
  });
});

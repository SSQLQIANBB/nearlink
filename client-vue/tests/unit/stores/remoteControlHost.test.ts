import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
const mock = vi.hoisted(() => ({
  desktop: true,
  invoke: vi.fn(),
  io: vi.fn(),
  release: vi.fn(),
  ice: vi.fn(),
  consent: vi.fn(),
  auth: { token: 'test-token' },
  channels: [] as any[],
  cleanups: [] as Array<() => void>,
  claims: [] as any[],
}));
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => mock.desktop,
  invoke: mock.invoke,
  Channel: class {
    onmessage: any;
    constructor() {
      mock.channels.push(this);
    }
  },
}));
vi.mock('socket.io-client', () => ({ io: mock.io }));
vi.mock('@/api/remoteControl', () => ({
  getRemoteControlRelease: mock.release,
  getRemoteSessionIce: mock.ice,
}));
vi.mock('@/services/remoteControlIce', () => ({ validateRemoteIceConfiguration: vi.fn() }));
vi.mock('@/services/remoteDeviceNative', () => ({ confirmRemoteNativeRequest: mock.consent, probeRemoteDeviceSupport: async () => ({ platform: 'macos' }) }));
vi.mock('@/services/remoteControlSafety', () => ({
  registerRemoteControlCleanup: (fn: () => void) => mock.cleanups.push(fn),
}));
vi.mock('@/services/mediaOccupancy', () => ({
  mediaOccupancy: {
    acquire: () => {
      const claim = { release: vi.fn() };
      mock.claims.push(claim);
      return claim;
    },
  },
}));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => mock.auth }));
import { useRemoteControlHostStore } from '@/stores/remoteControlHost';
const id = '11111111-1111-4111-8111-111111111111',
  device = '22222222-2222-4222-8222-222222222222';
class FakeSocket {
  connected = false;
  id = 'host-socket';
  handlers = new Map<string, Function>();
  on(event: string, callback: Function) {
    this.handlers.set(event, callback);
    return this;
  }
  connect() {
    this.connected = true;
  }
  disconnect = vi.fn(() => {
    this.connected = false;
  });
  removeAllListeners() {
    this.handlers.clear();
  }
  timeout() {
    return this;
  }
  emitWithAck = vi.fn(async (event: string, payload?: any) =>
    event === 'remote:credentials' ? { ok: true, credentials: { deviceCode: '123456789', temporaryPassword: 'abcdefgh23' } } : event === 'remote:presence' ? { ok: true } : { ok: true, sessionId: payload?.sessionId ?? id, revision: 1 },
  );
  receive(event: string, value: unknown) {
    this.handlers.get(event)?.(value);
  }
}
let socket: FakeSocket;
const flush = async () => {
  for (let n = 0; n < 12; n++) await Promise.resolve();
};
beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  mock.desktop = true;
  mock.channels.length = 0;
  mock.cleanups.length = 0;
  mock.claims.length = 0;
  socket = new FakeSocket();
  mock.io.mockReturnValue(socket);
  mock.invoke.mockResolvedValue({ format: 'native-proof' });
  mock.release.mockResolvedValue({ desktopHostEnabled: true, releasedPlatforms: ['macos'] });
  mock.ice.mockResolvedValue({ proof: { signed: 'ice' } });
});
afterEach(async () => {
  for (const cleanup of mock.cleanups) cleanup();
  await flush();
});
describe('desktop host bridge lifecycle', () => {
  it.each([
    ['PRESENCE_SIGNING_KEY_UNTRUSTED', '信任列表'],
    ['INVALID_PRESENCE_CHALLENGE', '签名或内容校验失败'],
  ])('explains %s and stays offline without sending presence', async (code, hint) => {
    const store = useRemoteControlHostStore();
    await store.start(device);
    mock.invoke.mockImplementation(async (command) => {
      if (command === 'remote_control_presence') throw code;
    });
    socket.receive('remote:presence-challenge', { proof: {} });
    await flush();
    expect(store.phase).toBe('offline');
    expect(store.error).toContain(hint);
    expect(store.error).toContain(code);
    expect(socket.emitWithAck).not.toHaveBeenCalled();
    expect(socket.disconnect).toHaveBeenCalled();
  });
  it('never opens a host socket from Web or when server release is closed', async () => {
    const store = useRemoteControlHostStore();
    mock.desktop = false;
    await store.start(device);
    expect(mock.io).not.toHaveBeenCalled();
    mock.desktop = true;
    mock.release.mockResolvedValue({ desktopHostEnabled: false, releasedPlatforms: [] });
    await store.start(device);
    expect(mock.io).not.toHaveBeenCalled();
    expect(store.phase).toBe('offline');
  });
  it('announces online only after native signed presence is acknowledged, without starting capture', async () => {
    const store = useRemoteControlHostStore();
    await store.start(device);
    expect(store.phase).toBe('starting');
    socket.receive('remote:presence-challenge', { proof: { challenge: 'signed' } });
    await flush();
    expect(mock.invoke).toHaveBeenCalledWith('remote_control_presence', {
      proof: { challenge: 'signed' },
    });
    expect(socket.emitWithAck).toHaveBeenCalledWith('remote:presence', {
      proof: { format: 'native-proof' },
    });
    expect(store.phase).toBe('online');
    expect(mock.invoke.mock.calls.some((c) => c[0] === 'remote_control_start_host')).toBe(false);
  });
  it('stopping during native consent aborts it and ignores a late approval', async () => {
    let confirm!: (proof: unknown) => void;
    mock.consent.mockReturnValue(
      new Promise((resolve) => {
        confirm = resolve;
      }),
    );
    const store = useRemoteControlHostStore();
    await store.start(device);
    socket.receive('remote:approval', {
      sessionId: id,
      state: 'pending',
      revision: 0,
      scope: 'view',
      authorizationRevision: 0,
      controlEpoch: 0,
      proof: {},
    });
    expect(store.phase).toBe('pending');
    const signal = mock.consent.mock.calls[0]![1] as AbortSignal;
    store.stop();
    expect(signal.aborted).toBe(true);
    confirm({ signed: 'late-consent' });
    await flush();
    expect(socket.emitWithAck).not.toHaveBeenCalled();
    expect(mock.claims[0].release).toHaveBeenCalled();
    expect(mock.invoke).toHaveBeenCalledWith('remote_control_stop');
    expect(store.phase).toBe('offline');
  });
  it('explains consent timeout and remains available without starting media', async () => {
    mock.consent.mockRejectedValue(new Error('REMOTE_NATIVE_TIMEOUT'));
    const store = useRemoteControlHostStore();
    await store.start(device);
    socket.receive('remote:approval', {
      sessionId: id,
      state: 'pending',
      revision: 0,
      scope: 'view',
      authorizationRevision: 0,
      controlEpoch: 0,
      proof: {},
    });
    await flush();
    expect(store.phase).toBe('online');
    expect(store.error).toContain('45 秒');
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(mock.ice).not.toHaveBeenCalled();
    expect(mock.invoke).toHaveBeenCalledWith('remote_control_stop');
    expect(mock.invoke.mock.calls.some((c) => c[0] === 'remote_control_start_host')).toBe(false);
  });
  it.each(['disconnect', 'remote:ended'])('%s during an ICE fetch cannot launch capture afterward', async (event) => {
    mock.consent.mockResolvedValue({ signed: 'consent' });
    let resolveIce!: (value: unknown) => void;
    mock.ice.mockReturnValue(
      new Promise((resolve) => {
        resolveIce = resolve;
      }),
    );
    const store = useRemoteControlHostStore();
    await store.start(device);
    socket.receive('remote:approval', {
      sessionId: id,
      state: 'pending',
      revision: 0,
      scope: 'view',
      authorizationRevision: 0,
      controlEpoch: 0,
      proof: {},
    });
    await flush();
    const endpoint = {
      userId: 1,
      sid: id,
      authVersion: id,
      endpointId: device,
      connectionId: 'host-socket',
      generation: 1,
    };
    socket.receive('remote:connecting', {
      sessionId: id,
      revision: 1,
      scope: 'view',
      authorizationRevision: 1,
      controlEpoch: 1,
      host: endpoint,
      controller: { ...endpoint, userId: 2, endpointId: id, connectionId: 'controller-socket' },
      consentNonce: 'A'.repeat(43),
      screenId: 'primary',
      negotiationId: id,
      hardDeadline: Date.now() + 3600000,
    });
    await flush();
    expect(mock.ice).toHaveBeenCalled();
    socket.receive(event, { sessionId: id });
    resolveIce({ proof: { signed: 'ice' } });
    await flush();
    expect(mock.invoke.mock.calls.some((c) => c[0] === 'remote_control_start_host')).toBe(false);
  });
  it('a failed native stop prevents a new online connection', async () => {
    const store = useRemoteControlHostStore();
    await store.start(device);
    mock.invoke.mockRejectedValue(new Error('native unavailable'));
    store.stop();
    await flush();
    const count = mock.io.mock.calls.length;
    await store.start(device);
    expect(mock.io).toHaveBeenCalledTimes(count);
    expect(store.phase).toBe('offline');
  });
  it.each(['REMOTE_CONNECT_TIMEOUT', 'private diagnostic /secret/token'])(
    'reports only safe native end codes: %s',
    async (reason) => {
      mock.consent.mockResolvedValue({ signed: 'consent' });
      const store = useRemoteControlHostStore();
      await store.start(device);
      socket.receive('remote:approval', {
        sessionId: id,
        state: 'pending',
        revision: 0,
        scope: 'view',
        authorizationRevision: 0,
        controlEpoch: 0,
        proof: {},
      });
      await flush();
      const endpoint = {
        userId: 1,
        sid: id,
        authVersion: id,
        endpointId: device,
        connectionId: 'host-socket',
        generation: 1,
      };
      socket.receive('remote:connecting', {
        sessionId: id,
        revision: 1,
        scope: 'view',
        authorizationRevision: 1,
        controlEpoch: 1,
        host: endpoint,
        controller: { ...endpoint, userId: 2, endpointId: id, connectionId: 'controller-socket' },
        consentNonce: 'A'.repeat(43),
        screenId: 'primary',
        negotiationId: id,
        hardDeadline: Date.now() + 3600000,
      });
      await flush();
      expect(mock.channels).toHaveLength(1);
      mock.channels[0].onmessage({ sessionId: id, type: 'ended', payload: { reason } });
      await flush();
      expect(store.phase).toBe('online');
      expect(socket.disconnect).not.toHaveBeenCalled();
      expect(mock.invoke).toHaveBeenCalledWith('remote_control_stop');
      expect(store.error).toBe(
        reason.startsWith('REMOTE_') ? `本机远控已停止。（${reason}）` : '本机远控已停止。',
      );
    },
  );
  it.each(['remote:state', 'remote:ended'])('keeps presence and credentials after %s and accepts another request', async (event) => {
    mock.consent.mockResolvedValue({ signed: 'consent' });
    const store = useRemoteControlHostStore();
    await store.start(device);
    socket.receive('remote:presence-challenge', { proof: {} });
    await flush();
    const credentials = store.credentials;
    const approval = { sessionId: id, state: 'pending', revision: 0, scope: 'control', authorizationRevision: 0, controlEpoch: 0, proof: {} };
    socket.receive('remote:approval', approval);
    await flush();
    socket.receive(event, { ...approval, state: 'ended', revision: 2 });
    await flush();
    expect(store.phase).toBe('online');
    expect(store.session).toBeNull();
    expect(store.credentials).toEqual(credentials);
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(mock.claims[0].release).toHaveBeenCalledOnce();
    expect(socket.emitWithAck.mock.calls.filter(([name]) => name === 'remote:credentials')).toHaveLength(1);
    socket.receive('remote:approval', { ...approval, sessionId: '33333333-3333-4333-8333-333333333333' });
    await flush();
    expect(store.phase).toBe('pending');
    expect(mock.consent).toHaveBeenCalledTimes(2);
    socket.receive('remote:signal', { sessionId: id, type: 'answer' });
    await flush();
    expect(store.phase).toBe('pending');
  });
  it('reuses credentials after disabling and clears them on account cleanup', async () => {
    const store = useRemoteControlHostStore();
    await store.start(device);
    socket.receive('remote:presence-challenge', { proof: {} });
    await flush();
    const credentials = store.credentials;
    store.stop();
    await flush();
    expect(store.credentials).toEqual(credentials);
    await store.start(device);
    socket.receive('remote:presence-challenge', { proof: {} });
    await flush();
    expect(socket.emitWithAck).toHaveBeenLastCalledWith('remote:credentials', { resume: credentials });
    await store.refreshCredentials();
    expect(socket.emitWithAck).toHaveBeenLastCalledWith('remote:credentials', {});
    mock.cleanups[0]!();
    await flush();
    expect(store.credentials).toBeNull();
  });
  it('ending locally notifies the server but disabling still disconnects', async () => {
    mock.consent.mockResolvedValue({ signed: 'consent' });
    const store = useRemoteControlHostStore();
    await store.start(device);
    socket.receive('remote:presence-challenge', { proof: {} });
    await flush();
    socket.receive('remote:approval', { sessionId: id, state: 'pending', revision: 0, scope: 'view', proof: {} });
    await flush();
    await store.endSession();
    expect(socket.emitWithAck).toHaveBeenCalledWith('remote:end', expect.objectContaining({ sessionId: id }));
    expect(store.phase).toBe('online');
    expect(store.credentials).not.toBeNull();
    store.stop();
    await flush();
    expect(store.phase).toBe('offline');
    expect(socket.disconnect).toHaveBeenCalledOnce();
  });

});

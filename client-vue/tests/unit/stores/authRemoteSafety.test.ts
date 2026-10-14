import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
const mocks = vi.hoisted(() => ({
  logout: vi.fn(),
  stop: vi.fn(),
  clear: vi.fn(),
  login: vi.fn(),
}));
vi.mock('@/api/auth', () => ({
  logout: mocks.logout,
  login: mocks.login,
  loginWithEmailCode: vi.fn(),
  getCurrentUser: vi.fn(),
}));
vi.mock('@/services/remoteControlSafety', () => ({
  stopRemoteControlLocally: mocks.stop,
  clearRemoteControlLocally: mocks.clear,
}));
import { useAuthStore } from '@/stores/auth';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  mocks.stop.mockResolvedValue(undefined);
  mocks.logout.mockResolvedValue(undefined);
});

describe('远控退出与身份隔离', () => {
  it('退出开始立刻改变generation，原生停止完成后才发送原sid登出', async () => {
    const stopped = deferred<void>();
    mocks.stop.mockReturnValue(stopped.promise);
    const auth = useAuthStore();
    auth.setAuth({ id: 1, username: 'old' }, 'old-access', 'old-refresh');
    const previous = auth.authGeneration;
    const pending = auth.logout();
    expect(auth.authGeneration).toBeGreaterThan(previous);
    expect(auth.loggingOut).toBe(true);
    expect(auth.isAuthenticated).toBe(false);
    expect(mocks.logout).not.toHaveBeenCalled();
    stopped.resolve();
    await pending;
    expect(mocks.logout).toHaveBeenCalledWith('old-access');
    expect(auth.token).toBeNull();
  });
  it('网络登出迟到不能清掉新登录；旧请求始终使用旧token', async () => {
    const response = deferred<void>();
    mocks.logout.mockReturnValue(response.promise);
    const auth = useAuthStore();
    auth.setAuth({ id: 1, username: 'old' }, 'old-access', 'old-refresh');
    const pending = auth.logout();
    await Promise.resolve();
    auth.setAuth({ id: 2, username: 'new' }, 'new-access', 'new-refresh');
    response.resolve();
    await pending;
    expect(mocks.logout).toHaveBeenCalledWith('old-access');
    expect(auth.token).toBe('new-access');
    expect(auth.currentUser?.id).toBe(2);
    expect(auth.loggingOut).toBe(false);
  });
  it('原生停止期间发生新登录，后续登出API也只能撤销旧token', async () => {
    const stopped = deferred<void>();
    mocks.stop.mockReturnValue(stopped.promise);
    const auth = useAuthStore();
    auth.setAuth({ id: 1, username: 'old' }, 'old-access', 'old-refresh');
    const pending = auth.logout();
    auth.setAuth({ id: 2, username: 'new' }, 'new-access', 'new-refresh');
    stopped.resolve();
    await pending;
    expect(mocks.logout).toHaveBeenCalledWith('old-access');
    expect(auth.token).toBe('new-access');
  });
  it('退出使先前仍在途的登录请求失效', async () => {
    const response = deferred<object>();
    mocks.login.mockReturnValue(response.promise);
    const auth = useAuthStore();
    const pending = auth.login({ username: 'old', password: 'test' });
    await auth.logout({ callApi: false });
    response.resolve({
      accessToken: 'stale',
      refreshToken: 'stale',
      user: { id: 1, username: 'old' },
    });
    await expect(pending).rejects.toThrow('Authentication changed during login');
    expect(auth.token).toBeNull();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { useAuthStore } from '@/stores/auth';
import { pinia } from '@/stores';
import { request, refreshAccessToken } from '../../../src/utils/request';

const routerMocks = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn(),
  currentRoute: {
    value: { fullPath: '/groups?view=mine' },
  },
}));

vi.mock('@/router', () => ({
  default: routerMocks,
}));

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function resetAuth() {
  const auth = useAuthStore(pinia);
  auth.currentUser = null;
  auth.token = null;
  auth.refreshToken = null;
  auth.loggingOut = false;
  localStorage.clear();
  return auth;
}

describe('request authentication recovery', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    routerMocks.replace.mockReset();
    routerMocks.push.mockReset();
    routerMocks.currentRoute.value.fullPath = '/groups?view=mine';
    resetAuth();
  });

  it('多个并发 401 只刷新、清理和跳转一次', async () => {
    const auth = useAuthStore(pinia);
    auth.setAuth({ id: 1, username: 'owner' }, 'expired-access-token', 'expired-refresh-token');

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/auth/logout')) {
        return jsonResponse(200, { message: 'ok' });
      }
      if (url.includes('/api/auth/refresh-token')) {
        return jsonResponse(401, { error: 'refresh token 已失效' });
      }
      return jsonResponse(401, { error: 'access token 已失效' });
    });
    vi.stubGlobal('fetch', fetchMock);

    await Promise.allSettled([request('/api/groups/my'), request('/api/messages/offline')]);

    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/auth/refresh-token')),
    ).toHaveLength(1);
    expect(routerMocks.replace).toHaveBeenCalledTimes(1);
    expect(routerMocks.replace).toHaveBeenCalledWith({
      name: 'Login',
      query: { redirect: '/groups?view=mine' },
    });
    expect(auth.token).toBeNull();
    expect(auth.refreshToken).toBeNull();
    expect(auth.currentUser).toBeNull();

    await Promise.allSettled([request('/api/groups/late-response')]);
    expect(routerMocks.replace).toHaveBeenCalledTimes(1);
  });

  it('刷新成功后只重试原请求一次并更新 token', async () => {
    const auth = useAuthStore(pinia);
    auth.setAuth({ id: 1, username: 'owner' }, 'expired-access-token', 'valid-refresh-token');
    let resourceRequests = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/auth/refresh-token')) {
          return jsonResponse(200, {
            accessToken: 'new-access-token',
            refreshToken: 'new-refresh-token',
          });
        }
        resourceRequests += 1;
        return resourceRequests === 1
          ? jsonResponse(401, { error: 'expired' })
          : jsonResponse(200, { value: 'ok' });
      }),
    );

    await expect(request<{ value: string }>('/api/groups/my')).resolves.toEqual({ value: 'ok' });
    expect(resourceRequests).toBe(2);
    expect(auth.token).toBe('new-access-token');
    expect(routerMocks.replace).not.toHaveBeenCalled();
  });

  it('403 权限不足不会清除登录状态', async () => {
    const auth = useAuthStore(pinia);
    auth.setAuth({ id: 1, username: 'owner' }, 'valid-token', 'valid-refresh');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(403, { error: '没有权限' })));

    await expect(request('/api/groups/7')).rejects.toThrow('没有权限');
    expect(auth.token).toBe('valid-token');
    expect(routerMocks.replace).not.toHaveBeenCalled();
  });

  it('登录接口 401 不刷新且不产生重定向循环', async () => {
    const auth = useAuthStore(pinia);
    auth.setAuth({ id: 1, username: 'owner' }, 'old-token', 'old-refresh');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(401, { error: '用户名或密码错误' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      request('/api/auth/login', {
        method: 'POST',
        body: { username: 'owner', password: 'wrong' },
      }),
    ).rejects.toThrow('用户名或密码错误');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(routerMocks.replace).not.toHaveBeenCalled();
    expect(auth.token).toBe('old-token');
  });

  it('没有 refreshToken 时直接统一退出并保留原访问地址', async () => {
    const auth = useAuthStore(pinia);
    auth.setAuth({ id: 1, username: 'owner' }, 'expired-token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, { error: 'expired' })));

    await expect(request('/api/groups/my')).rejects.toThrow();

    expect(routerMocks.replace).toHaveBeenCalledTimes(1);
    expect(routerMocks.replace).toHaveBeenCalledWith({
      name: 'Login',
      query: { redirect: '/groups?view=mine' },
    });
    expect(auth.token).toBeNull();
  });

  it('路由守卫恢复用户的 401 交由守卫跳转，不发起嵌套路由导航', async () => {
    const auth = useAuthStore(pinia);
    auth.setAuth({ id: 1, username: 'owner' }, 'expired-token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, { error: 'expired' })));

    await expect(
      request('/api/auth/me', {
        _skipAuthRedirect: true,
      } as any),
    ).rejects.toThrow('expired');

    expect(routerMocks.replace).not.toHaveBeenCalled();
  });
});

describe('刷新凭据幂等与退出竞态', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetAuth();
  });

  it('取消登记请求不会中断共享刷新，但取消的POST不再重放', async () => {
    const auth = useAuthStore(pinia);
    auth.setAuth({ id: 1, username: 'owner' }, 'access', 'refresh');
    let resolve!: (value: Response) => void;
    const fetchMock = vi.fn((url: string) =>
      url.includes('refresh-token')
        ? new Promise<Response>((done) => {
            resolve = done;
          })
        : Promise.resolve(jsonResponse(401, { error: 'expired' })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const abort = new AbortController();
    const pending = request('/api/remote-control/devices', {
      method: 'POST',
      body: {},
      signal: abort.signal,
    });
    await flushPromises();
    const shared = refreshAccessToken();
    abort.abort();
    const rejected = expect(pending).rejects.toThrow();
    resolve(jsonResponse(200, { accessToken: 'new-access', refreshToken: 'new-refresh' }));
    expect(await shared).toBe(true);
    await rejected;
    expect(auth.token).toBe('new-access');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('丢失刷新响应后使用相同requestId与旧凭据恢复，下轮使用新ID', async () => {
    const auth = useAuthStore(pinia);
    auth.setAuth({ id: 1, username: 'owner' }, 'access', 'refresh');
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('response lost'))
      .mockResolvedValueOnce(
        jsonResponse(200, { accessToken: 'next-access', refreshToken: 'next-refresh' }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { accessToken: 'last-access', refreshToken: 'last-refresh' }),
      );
    vi.stubGlobal('fetch', fetchMock);
    expect(await refreshAccessToken()).toBe(true);
    const first = JSON.parse(fetchMock.mock.calls[0]![1].body);
    const retry = JSON.parse(fetchMock.mock.calls[1]![1].body);
    expect(first.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(retry).toEqual(first);
    expect(await refreshAccessToken()).toBe(true);
    const next = JSON.parse(fetchMock.mock.calls[2]![1].body);
    expect(next.requestId).not.toBe(first.requestId);
    expect(next.refreshToken).toBe('next-refresh');
  });

  it('Socket和HTTP并发刷新共用同一次凭据轮换', async () => {
    const auth = useAuthStore(pinia);
    auth.setAuth({ id: 1, username: 'owner' }, 'access', 'refresh');
    let resolve!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const first = refreshAccessToken();
    const second = refreshAccessToken();
    expect(first).toBe(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve(jsonResponse(200, { accessToken: 'next-access', refreshToken: 'next-refresh' }));
    expect(await first).toBe(true);
    expect(await second).toBe(true);
  });

  it('新登录的刷新不复用旧身份的在途失败promise', async () => {
    const auth = useAuthStore(pinia);
    auth.setAuth({ id: 1, username: 'old' }, 'old-access', 'old-refresh');
    const responses: Array<(response: Response) => void> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((done) => {
            responses.push(done);
          }),
      ),
    );
    const old = refreshAccessToken();
    auth.setAuth({ id: 2, username: 'new' }, 'new-access', 'new-refresh');
    const current = refreshAccessToken();
    expect(old).not.toBe(current);
    responses[0]!(
      jsonResponse(200, { accessToken: 'stale-access', refreshToken: 'stale-refresh' }),
    );
    expect(await old).toBe(false);
    responses[1]!(
      jsonResponse(200, { accessToken: 'valid-access', refreshToken: 'valid-refresh' }),
    );
    expect(await current).toBe(true);
    expect(auth.token).toBe('valid-access');
    expect(auth.currentUser?.id).toBe(2);
  });

  it('刷新完成与原请求重试之间切换身份时不以新身份重放旧请求', async () => {
    const auth = useAuthStore(pinia);
    auth.setAuth({ id: 1, username: 'old' }, 'old-access', 'old-refresh');
    vi.spyOn(auth, 'updateToken').mockImplementation(() => {
      auth.setAuth({ id: 2, username: 'new' }, 'new-access', 'new-refresh');
    });
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        url.includes('refresh-token')
          ? jsonResponse(200, { accessToken: 'rotated', refreshToken: 'rotated-refresh' })
          : jsonResponse(401, { error: 'expired' }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      request('/api/messages/send', { method: 'POST', body: { text: 'old account' } }),
    ).rejects.toThrow('Authentication changed during request');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(auth.token).toBe('new-access');
  });

  it('退出已经开始但token尚未清除时，迟到刷新也不能换入新凭据', async () => {
    const auth = useAuthStore(pinia);
    auth.setAuth({ id: 1, username: 'owner' }, 'access', 'refresh');
    let resolveRefresh!: (response: Response) => void;
    let resolveLogout!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (url: string) =>
          new Promise((done) => {
            if (url.includes('refresh-token')) resolveRefresh = done;
            else resolveLogout = done;
          }),
      ),
    );
    const refresh = refreshAccessToken();
    const logout = auth.logout();
    await Promise.resolve();
    expect(auth.token).toBe('access');
    expect(auth.loggingOut).toBe(true);
    resolveRefresh(
      jsonResponse(200, { accessToken: 'stale-access', refreshToken: 'stale-refresh' }),
    );
    expect(await refresh).toBe(false);
    expect(auth.token).toBe('access');
    resolveLogout(jsonResponse(200, { message: 'ok' }));
    await logout;
    expect(auth.token).toBeNull();
  });

  it('退出后迟到的刷新响应不恢复登录', async () => {
    const auth = useAuthStore(pinia);
    auth.setAuth({ id: 1, username: 'owner' }, 'access', 'refresh');
    let resolve!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      ),
    );
    const pending = refreshAccessToken();
    auth.clearAuthLocal();
    resolve(jsonResponse(200, { accessToken: 'stale-access', refreshToken: 'stale-refresh' }));
    expect(await pending).toBe(false);
    expect(auth.token).toBeNull();
    expect(auth.refreshToken).toBeNull();
  });
});

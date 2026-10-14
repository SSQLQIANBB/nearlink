import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const mocks = vi.hoisted(() => ({
  passwordLogin: vi.fn(),
  emailLogin: vi.fn(),
}));

vi.mock('@/api/auth', () => ({
  login: mocks.passwordLogin,
  loginWithEmailCode: mocks.emailLogin,
}));

import { useAuthStore } from '../../../src/stores/auth';

const result = {
  accessToken: 'access',
  refreshToken: 'refresh',
  user: { id: 7, username: 'alice' },
  message: '登录成功',
};

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  mocks.passwordLogin.mockResolvedValue(result);
  mocks.emailLogin.mockResolvedValue(result);
});

describe('两种登录方式', () => {
  it('账号密码使用原接口，邮箱验证码使用新接口且保存相同会话状态', async () => {
    const store = useAuthStore();
    await store.login({ username: 'alice@example.com', password: 'old-password' });
    expect(mocks.passwordLogin).toHaveBeenCalledWith({
      username: 'alice@example.com',
      password: 'old-password',
    });
    expect(mocks.emailLogin).not.toHaveBeenCalled();

    store.clearAuthLocal();
    await store.login({ email: 'alice@example.com', code: '123456' });
    expect(mocks.emailLogin).toHaveBeenCalledWith({ email: 'alice@example.com', code: '123456' });
    expect(store.currentUser?.id).toBe(7);
    expect(store.token).toBe('access');
    expect(store.refreshToken).toBe('refresh');
  });
});

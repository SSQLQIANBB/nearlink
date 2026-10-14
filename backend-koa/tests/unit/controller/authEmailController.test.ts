import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findBinding: vi.fn(),
  findUser: vi.fn(),
  consume: vi.fn(),
  issue: vi.fn(),
}));
vi.mock('../../../src/config/redis', () => ({
  default: { incr: vi.fn(async () => 1), expire: vi.fn() },
}));
vi.mock('../../../src/models', () => ({
  UserEmail: { findOne: mocks.findBinding, findByPk: vi.fn(async () => null) },
  User: { findByPk: mocks.findUser },
}));
vi.mock('../../../src/services/redisService', () => ({ default: { delRefreshToken: vi.fn() } }));
vi.mock('../../../src/services/emailVerificationService', () => ({
  normalizeEmail: (value: string) => value,
  consumeEmailCode: mocks.consume,
  isMailConfigured: () => true,
  issueEmailCode: mocks.issue,
}));
vi.mock('../../../src/services/loginSessionService', () => ({
  replacePasswordAndRevokeSessions: vi.fn(),
}));

import {
  resetPassword,
  sendLoginCode,
  sendResetCode,
} from '../../../src/controller/authEmailController';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('邮箱找回密码', () => {
  it('只信任验证绑定表，不能凭旧用户资料邮箱找回', async () => {
    mocks.findBinding.mockResolvedValue(null);
    const ctx = {
      request: { body: { email: 'legacy@example.com', code: '123456', newPassword: 'Newpass1!' } },
      status: 200,
    } as any;
    await resetPassword(ctx);
    expect(ctx.status).toBe(400);
    expect(mocks.findUser).not.toHaveBeenCalled();
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it('新密码不符合规则时拒绝重置，且不消耗验证码', async () => {
    const ctx = {
      request: { body: { email: 'test@example.com', code: '123456', newPassword: 'Weakpass😊1' } },
      status: 200,
    } as any;
    await resetPassword(ctx);
    expect(ctx.status).toBe(400);
    expect(mocks.findBinding).not.toHaveBeenCalled();
    expect(mocks.consume).not.toHaveBeenCalled();
  });
});

describe('邮箱登录和找回密码发码', () => {
  it.each([
    ['邮箱验证码登录', sendLoginCode],
    ['找回密码', sendResetCode],
  ])('%s对未注册邮箱提示错误', async (_name, sendCode) => {
    const ctx = {
      request: { body: { email: 'alice@example.com' } },
      ip: '127.0.0.1',
      status: 200,
    } as any;
    mocks.findBinding.mockResolvedValue(null);
    await sendCode(ctx);
    expect(ctx.status).toBe(404);
    expect(ctx.body.error).toBe('该邮箱未注册');
    expect(mocks.issue).not.toHaveBeenCalled();
  });

  it('已注册邮箱处于冷却期时保持原有成功提示', async () => {
    const ctx = {
      request: { body: { email: 'alice@example.com' } },
      ip: '127.0.0.1',
      status: 200,
    } as any;
    mocks.findBinding.mockResolvedValue({ userId: 7 });
    mocks.issue.mockResolvedValue('cooldown');
    await sendLoginCode(ctx);
    expect(ctx.status).toBe(200);
    expect(ctx.body.message).toBe('验证码已发送');
    expect(mocks.issue).toHaveBeenCalledWith('login', 'alice@example.com');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  values: new Map<string, string>(),
  sendMail: vi.fn(),
}));

vi.mock('../../../src/config/redis', () => ({
  default: {
    set: vi.fn(async (key: string, value: string, ...options: string[]) => {
      if (options.includes('NX') && mocks.values.has(key)) return null;
      mocks.values.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => mocks.values.get(key) || null),
    getdel: vi.fn(async (key: string) => {
      const value = mocks.values.get(key) || null;
      mocks.values.delete(key);
      return value;
    }),
    del: vi.fn(async (...keys: string[]) => keys.forEach((key) => mocks.values.delete(key))),
    incr: vi.fn(async (key: string) => {
      const count = Number(mocks.values.get(key) || 0) + 1;
      mocks.values.set(key, String(count));
      return count;
    }),
    expire: vi.fn(),
  },
}));
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: mocks.sendMail,
      close: vi.fn(),
    }),
  },
}));

import {
  consumeEmailCode,
  issueEmailCode,
  normalizeEmail,
} from '../../../src/services/emailVerificationService';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.values.clear();
  mocks.sendMail.mockResolvedValue({});
});

describe('邮箱验证码', () => {
  it('规范化邮箱，验证码限时存储哈希且只能消费一次', async () => {
    const email = normalizeEmail(' Alice@Example.com ');
    expect(email).toBe('alice@example.com');
    expect(normalizeEmail('invalid')).toBeNull();
    expect(await issueEmailCode('register', email!)).toBe('sent');
    const code = String(mocks.sendMail.mock.calls[0]![0].text).match(/\b\d{6}\b/)![0];
    expect([...mocks.values.values()]).not.toContain(code);
    expect(await issueEmailCode('register', email!)).toBe('cooldown');
    expect(await consumeEmailCode('register', email!, code)).toBe(true);
    expect(await consumeEmailCode('register', email!, code)).toBe(false);
  });

  it('错误验证码超过五次后失效，邮件发送失败时清理冷却时间', async () => {
    const email = 'alice@example.com';
    await issueEmailCode('reset', email);
    const code = String(mocks.sendMail.mock.calls[0]![0].text).match(/\b\d{6}\b/)![0];
    for (let index = 0; index < 6; index++) {
      expect(await consumeEmailCode('reset', email, '000000' === code ? '111111' : '000000')).toBe(
        false,
      );
    }
    expect(await consumeEmailCode('reset', email, code)).toBe(false);

    mocks.values.clear();
    mocks.sendMail.mockRejectedValueOnce(new Error('SMTP unavailable'));
    await expect(issueEmailCode('bind', email)).rejects.toThrow('SMTP unavailable');
    expect(await issueEmailCode('bind', email)).toBe('sent');
  });
});

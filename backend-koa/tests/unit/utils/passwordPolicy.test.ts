import { describe, expect, it } from 'vitest';
import { isValidNewPassword } from '../../../src/utils/passwordPolicy';

describe('新密码规则', () => {
  it.each(['Abc123', 'Abc123!@#', 'A1b-_=+[]{};:,.?/'])(
    '接受包含大小写和数字的英文键盘字符：%s',
    (password) => {
      expect(isValidNewPassword(password)).toBe(true);
    },
  );

  it.each(['Ab123', 'abcdef1', 'ABCDEF1', 'Abcdef', 'Abc 123', 'Abc123中', 'Abc123😊', 'Abc123\n'])(
    '拒绝不符合规则的字符或组合：%s',
    (password) => {
      expect(isValidNewPassword(password)).toBe(false);
    },
  );
});

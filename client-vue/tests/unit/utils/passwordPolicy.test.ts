import { describe, expect, it } from 'vitest';
import { isValidNewPassword } from '../../../src/utils/passwordPolicy';

describe('新密码表单校验', () => {
  it.each(['Abc123', 'Abc123!@#', 'A1b-_=+[]{};:,.?/'])(
    '接受英文键盘上的合法组合：%s',
    (password) => {
      expect(isValidNewPassword(password)).toBe(true);
    },
  );

  it.each(['Ab123', 'abcdef1', 'ABCDEF1', 'Abcdef', 'Abc 123', 'Abc123中', 'Abc123😊', 'Abc123\n'])(
    '拒绝弱密码或非半角字符：%s',
    (password) => {
      expect(isValidNewPassword(password)).toBe(false);
    },
  );
});

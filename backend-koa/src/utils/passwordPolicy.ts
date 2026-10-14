export const PASSWORD_RULE_MESSAGE =
  '密码至少 6 位，须包含大写字母、小写字母和数字，仅支持英文半角字符且不能有空格';

export function isValidNewPassword(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 6 &&
    /^[\x21-\x7E]+$/.test(value) &&
    /[A-Z]/.test(value) &&
    /[a-z]/.test(value) &&
    /[0-9]/.test(value)
  );
}

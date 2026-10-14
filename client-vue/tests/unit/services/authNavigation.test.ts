import { describe, expect, it } from 'vitest';
import { getAuthRedirect, resolvePostLoginPath } from '../../../src/services/authNavigation';

describe('authNavigation', () => {
  it('保留安全的站内完整路径', () => {
    expect(getAuthRedirect('/groups?tab=members')).toBe('/groups?tab=members');
    expect(resolvePostLoginPath('/group-chat/7')).toBe('/group-chat/7');
  });

  it('拒绝外部 URL、协议相对 URL 和登录页循环', () => {
    expect(getAuthRedirect('https://evil.example')).toBeUndefined();
    expect(getAuthRedirect('//evil.example')).toBeUndefined();
    expect(getAuthRedirect('/login?redirect=/groups')).toBeUndefined();
  });

  it('缺少或非法 redirect 时回到 Remote 首页', () => {
    expect(resolvePostLoginPath(undefined)).toBe('/remote');
    expect(resolvePostLoginPath('https://evil.example')).toBe('/remote');
    expect(resolvePostLoginPath(['/groups', '/profile'])).toBe('/remote');
  });
});

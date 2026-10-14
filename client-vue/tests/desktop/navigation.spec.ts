import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const {
  app: {
    security: { csp },
  },
} = JSON.parse(readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));

test('桌面构建使用 hash 路由，刷新个人中心并连接配置的服务端', async ({ page }, testInfo) => {
  const apiRequests: string[] = [];
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('http://127.0.0.1:1421/', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), 'content-security-policy': csp },
    });
  });
  await page.addInitScript(() => {
    localStorage.setItem(
      '__STORAGE_PERSIST_AUTH_',
      JSON.stringify({ token: 'desktop-test', refreshToken: 'test' }),
    );
  });
  await page.routeWebSocket(/\/meeting\//, (socket) => socket.close());
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    apiRequests.push(url.origin);
    if (url.pathname === '/api/auth/me')
      return route.fulfill({
        json: { user: { id: 1, username: 'desktop', nickname: '桌面测试用户' } },
      });
    if (url.pathname === '/api/auth/email') return route.fulfill({ json: { email: null } });
    if (url.pathname === '/api/auth/notification-settings')
      return route.fulfill({
        json: {
          settings: {
            desktopEnabled: true,
            messagePreview: true,
            notifyPrivateMessage: true,
            notifyGroupMessage: true,
            notifyCall: true,
            notifyInvitation: true,
            messageEnabled: true,
            callEnabled: true,
            messageTone: 'default',
            callTone: 'default',
          },
        },
      });
    return route.fulfill({
      json: { messages: [], invitations: [], groups: [], count: 0, hasMore: false, cursors: {} },
    });
  });
  await page.goto('/#/profile');
  await expect(page.getByRole('button', { name: '保存修改' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '保存修改' })).toBeVisible();
  await page.getByText('通知设置', { exact: true }).click();
  await expect(page.getByRole('switch', { name: '私聊消息', exact: true })).toBeEnabled();
  expect(apiRequests.length).toBeGreaterThan(0);
  expect(apiRequests.every((origin) => origin !== 'http://127.0.0.1:1421')).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(pageErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('desktop-profile.png') });
});

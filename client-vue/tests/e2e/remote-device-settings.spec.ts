import { expect, test } from '@playwright/test';

for (const width of [1440, 390])
  test(`Web本人设备管理与撤销确认 ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => {
      const token = `header.${btoa(JSON.stringify({ userId: 1, sid: '22222222-2222-4222-8222-222222222222' }))}.signature`;
      localStorage.setItem(
        '__STORAGE_PERSIST_AUTH_',
        JSON.stringify({ token, refreshToken: 'browser-test' }),
      );
    });
    const device = {
      deviceId: '11111111-1111-4111-8111-111111111111',
      alias: '办公室 MacBook',
      platform: 'macos',
      revokedAt: null as string | null,
      createdAt: new Date().toISOString(),
    };
    let registrations = 0;
    let revoked = 0;
    await page.route('**/meeting/**', (route) => route.abort());
    await page.route('**/api/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (!path.startsWith('/api/')) return route.continue();
      if (path === '/api/auth/me')
        return route.fulfill({ json: { user: { id: 1, username: 'owner' } } });
      if (path === '/api/auth/email') return route.fulfill({ json: { email: null } });
      if (path === '/api/remote-control/devices') {
        if (route.request().method() === 'POST') registrations++;
        return route.fulfill({ json: { devices: [device] } });
      }
      if (
        path === `/api/remote-control/devices/${device.deviceId}` &&
        route.request().method() === 'DELETE'
      ) {
        revoked++;
        device.revokedAt = new Date().toISOString();
        return route.fulfill({ json: { ok: true } });
      }
      return route.fulfill({
        json: {
          settings: {},
          sessions: [],
          releasedPlatforms: [],
          targets: [],
          groups: [],
          messages: [],
          invitations: [],
          users: [],
          count: 0,
        },
      });
    });
    await page.goto('/profile');
    await page.getByText('远程设备', { exact: true }).click();
    const panel = page.getByRole('region', { name: '远程设备管理' });
    await expect(panel.getByText('办公室 MacBook', { exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: '登记当前设备' })).toHaveCount(0);
    await expect(
      panel.getByText('请使用支持设备登记的桌面客户端登记电脑。你仍可在此管理已有设备。'),
    ).toBeVisible();
    await panel.getByRole('button', { name: '撤销登记' }).click();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    expect(revoked).toBe(0);
    await panel.getByRole('button', { name: '撤销登记' }).click();
    await page.getByRole('button', { name: '确认', exact: true }).click();
    await expect(panel.getByText('· macOS · 已撤销', { exact: true })).toBeVisible();
    expect(revoked).toBe(1);
    expect(registrations).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath('remote-devices.png') });
  });

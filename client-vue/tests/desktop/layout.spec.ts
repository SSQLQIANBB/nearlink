import { test, expect, type Page } from '@playwright/test';

async function openChat(page: Page, platform: 'MacIntel' | 'Win32', contactCount = 1) {
  await page.addInitScript(platform => {
    Object.defineProperty(navigator, 'platform', { get: () => platform });
    localStorage.setItem('__STORAGE_PERSIST_AUTH_', JSON.stringify({ token: 'desktop-test', refreshToken: 'test' }));
  }, platform);
  await page.routeWebSocket(/\/meeting\//, socket => socket.close());
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'desktop', nickname: '桌面测试用户' } } });
    if (url.pathname === '/api/auth/users') return route.fulfill({ json: { users: Array.from({ length: contactCount }, (_, index) => ({ id: index + 2, username: `contact${index}`, nickname: index ? `联系人${index}` : '聊天测试联系人' })) } });
    if (url.pathname === '/api/auth/notification-settings') return route.fulfill({ json: { settings: {} } });
    return route.fulfill({ json: { users: [], messages: [], invitations: [], groups: [], count: 0, hasMore: false, cursors: {} } });
  });
  await page.goto('/#/remote');
  await page.locator('.contact-item').filter({ hasText: '聊天测试联系人' }).click();
  await expect(page.locator('.chat-header')).toBeVisible();
}

for (const platform of ['Win32', 'MacIntel'] as const) {
  test(`${platform} 外层不滚动，联系人列表仍可独立滚动`, async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await openChat(page, platform, 40);
    await expect(page.locator('html')).toHaveCSS('overflow-y', 'hidden');
    await expect(page.locator('body')).toHaveCSS('overflow-y', 'hidden');
    await expect(page.locator('#app > .n-config-provider')).toHaveCSS('overflow-y', 'hidden');
    await expect(page.locator('html')).toHaveCSS('overscroll-behavior-y', 'none');
    const contacts = page.locator('.remote-sidebar .n-scrollbar-container').filter({ has: page.locator('.contact-list') });
    await contacts.hover();
    await page.mouse.wheel(0, 700);
    await expect.poll(() => contacts.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await contacts.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.mouse.wheel(0, 700);
    await page.locator('.chat-header').hover();
    await page.mouse.wheel(0, 700);
    await expect(page.locator('.remote-shell')).toHaveJSProperty('offsetHeight', 600);
    expect(await page.locator('.remote-shell').boundingBox()).toMatchObject({ y: 0, height: 600 });
    expect(await page.evaluate(() => [window.scrollY, document.body.scrollTop, document.querySelector('#app > .n-config-provider')!.scrollTop, document.querySelector('.app-route-content')!.scrollTop])).toEqual([0, 0, 0, 0]);
  });
}

test('桌面聊天布局在不同窗口尺寸下铺满可用内容区', async ({ page }, testInfo) => {
  await openChat(page, 'MacIntel');
  await expect(page.getByRole('group', { name: '窗口控制' })).toHaveCount(0);
  for (const viewport of [{ width: 1440, height: 900 }, { width: 800, height: 600 }]) {
    await page.setViewportSize(viewport);
    const shell = page.locator('.remote-shell');
    await expect(shell).toBeVisible();
    const bounds = await shell.boundingBox();
    const dragRegion = page.locator('.desktop-window-drag-region');
    if (await dragRegion.count()) {
      expect(await dragRegion.boundingBox()).toMatchObject({ x: 0, y: 0, width: 320, height: 44 });
      await expect(dragRegion).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(dragRegion).toHaveCSS('border-bottom-width', '0px');
      await expect(dragRegion).toHaveAttribute('data-tauri-drag-region', '');
      const profile = await page.locator('.sidebar-profile').boundingBox();
      expect(profile!.y).toBe(0);
      const avatar = await page.locator('.profile-avatar').boundingBox();
      expect(avatar!.y).toBeGreaterThanOrEqual(44);
      expect(avatar!.y).toBeLessThan(52);
      expect(await page.locator('.chat-header').boundingBox()).toMatchObject({ y: 0, height: 64 });
      // 联系人信息上移后，不应被透明拖动区域覆盖。
      expect(await page.locator('.chat-header .n-avatar').evaluate(element => {
        const rect = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      })).toBe(true);
    }
    expect(bounds!.y).toBe(0);
    expect(bounds!.x).toBe(0);
    expect(bounds!.width).toBe(viewport.width);
    expect(bounds!.y + bounds!.height).toBe(viewport.height);
    await expect(shell).toHaveCSS('border-radius', '0px');
    await expect(shell).toHaveCSS('box-shadow', 'none');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(viewport.height);
  }
  await page.screenshot({ path: testInfo.outputPath('desktop-full-window.png') });
  // 浏览器中模拟由原生窗口事件同步的全屏状态，检查留白和遮挡。
  await page.evaluate(() => document.documentElement.classList.add('desktop-fullscreen'));
  await expect(page.locator('.desktop-window-drag-region')).toBeHidden();
  await expect(page.locator('.desktop-chat-top-drag-region')).toBeHidden();
  await expect(page.locator('.sidebar-profile')).toHaveCSS('padding-top', '16px');
  expect((await page.locator('.profile-avatar').boundingBox())!.y).toBeLessThan(28);
  await page.screenshot({ path: testInfo.outputPath('desktop-fullscreen.png') });
  await page.evaluate(() => document.documentElement.classList.remove('desktop-fullscreen'));
  await expect(page.locator('.sidebar-profile')).toHaveCSS('padding-top', '44px');
  await expect(page.locator('.desktop-window-drag-region')).toBeVisible();
  // 顶部热区不能遮挡侧栏操作，也不能在页面切换后产生额外高度。
  await page.getByRole('button', { name: '个人中心', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存修改' })).toBeVisible();
  const back = page.getByRole('button', { name: '返回', exact: true });
  if (await page.locator('.desktop-window-drag-region').count()) {
    expect((await back.boundingBox())!.y).toBeGreaterThanOrEqual(44);
  }
  await back.click();
  await expect(page.locator('.remote-shell')).toBeVisible();
});

test('Windows 窗口按钮叠放于右上角，内容贴顶且不遮挡页面操作', async ({ page }, testInfo) => {
  await openChat(page, 'Win32');
  const controls = page.getByRole('group', { name: '窗口控制' });
  await expect(controls).toBeVisible();
  await expect(controls.getByRole('button')).toHaveCount(3);
  await expect(page.locator('.desktop-window-drag-region')).toHaveCount(0);
  for (const viewport of [{ width: 1200, height: 800 }, { width: 800, height: 600 }]) {
    await page.setViewportSize(viewport);
    expect(await controls.boundingBox()).toMatchObject({ x: viewport.width - 138, y: 0, width: 138, height: 32 });
    expect(await page.locator('.remote-shell').boundingBox()).toMatchObject({ x: 0, y: 0, width: viewport.width, height: viewport.height });
    expect(await page.locator('.chat-header').boundingBox()).toMatchObject({ y: 0, height: 64 });
    await expect(page.locator('.chat-header')).toHaveCSS('padding-right', '154px');
    await expect(controls).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await page.screenshot({ path: testInfo.outputPath(`windows-chat-${viewport.width}.png`) });
  }
  await page.getByRole('button', { name: '个人中心', exact: true }).click();
  const back = page.getByRole('button', { name: '返回', exact: true });
  expect((await back.boundingBox())!.y).toBeGreaterThanOrEqual(48);
  await back.click();
  await expect(page.locator('.remote-shell')).toBeVisible();
  await page.evaluate(() => document.documentElement.classList.add('desktop-fullscreen'));
  await expect(controls).toBeHidden();
  await expect(page.locator('.desktop-windows-drag-region')).toBeHidden();
  await page.evaluate(() => document.documentElement.classList.remove('desktop-fullscreen'));
  await expect(controls).toBeVisible();
});

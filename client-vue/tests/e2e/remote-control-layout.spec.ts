import { expect, test } from '@playwright/test';

for (const width of [1440, 900]) {
  test(`焦点和按钮刷新保持远控布局稳定 ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 700 });
    await page.addInitScript(() =>
      localStorage.setItem(
        '__STORAGE_PERSIST_AUTH_',
        JSON.stringify({ token: 'layout-test', refreshToken: 'layout-refresh' }),
      ),
    );
    await page.routeWebSocket(/\/meeting(?:\/|\?|$)/, (socket) => socket.close());
    await page.route('**/meeting/**', (route) => route.abort());
    await page.route('**/api/auth/**', (route) =>
      route.fulfill({
        json: route.request().url().includes('/auth/me')
          ? { user: { id: 1, username: 'layout-test' } }
          : {},
      }),
    );
    let releaseResponse: (() => void) | undefined;
    let hold = false;
    await page.route('**/api/remote-control/capabilities', async (route) => {
      if (hold)
        await new Promise<void>((resolve) => {
          releaseResponse = resolve;
        });
      await route.fulfill({
        json: {
          protocolVersion: 1,
          desktopControllerEnabled: true,
          desktopHostEnabled: true,
          webControllerReleaseEnabled: true,
          releasedPlatforms: ['windows', 'macos'],
          engineRequired: true,
        },
      });
    });
    await page.goto('/remote-control');
    const workbench = page.locator('.remote-workbench');
    await expect(workbench.locator('.hint p')).toContainText('此设备可作为主控端');
    await expect(workbench.locator('.connection-form > .hint')).toHaveCount(0);
    await workbench.evaluate((element) => {
      element.scrollTop = 180;
    });
    const geometry = () =>
      workbench.evaluate((element) => {
        const rect = element.querySelector('.connection-fields')!.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          scrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight,
        };
      });
    const before = await geometry();
    for (let i = 0; i < 3; i++) {
      hold = true;
      releaseResponse = undefined;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect.poll(() => !!releaseResponse).toBe(true);
      await expect(workbench.locator('.connection-form > .hint')).toHaveCount(0);
      expect(await geometry()).toEqual(before);
      hold = false;
      releaseResponse!();
      await expect(workbench.getByRole('button', { name: '刷新可用状态' })).toBeEnabled();
      expect(await geometry()).toEqual(before);
    }
    await workbench.evaluate((element) => {
      element.scrollTop = 0;
    });
    const refresh = workbench.getByRole('button', { name: '刷新可用状态' });
    const beforeClick = await geometry();
    const buttonBox = await refresh.boundingBox();
    hold = true;
    releaseResponse = undefined;
    await refresh.click();
    await expect.poll(() => !!releaseResponse).toBe(true);
    await expect(refresh).toBeDisabled();
    await expect(refresh).toHaveAttribute('aria-busy', 'true');
    await page.screenshot({ path: testInfo.outputPath('remote-refresh-loading.png') });
    // Cover the icon transition, not just the final loading state.
    for (let frame = 0; frame < 30; frame++) {
      await page.evaluate(() => new Promise(requestAnimationFrame));
      await expect(refresh.locator('.icon-refresh')).toHaveCount(1);
      await expect(refresh.locator('.n-base-loading')).toHaveCount(0);
      expect(await refresh.boundingBox()).toEqual(buttonBox);
      expect(await geometry()).toEqual(beforeClick);
    }
    hold = false;
    releaseResponse!();
    await expect(refresh).toBeEnabled();
    for (let frame = 0; frame < 30; frame++) {
      await page.evaluate(() => new Promise(requestAnimationFrame));
      await expect(refresh.locator('.icon-refresh')).toHaveCount(1);
      await expect(refresh.locator('.n-base-loading')).toHaveCount(0);
      expect(await refresh.boundingBox()).toEqual(buttonBox);
      expect(await geometry()).toEqual(beforeClick);
    }
    const heading = workbench.locator('.workbench-heading');
    await expect(heading.getByRole('button', { name: '刷新可用状态' })).toBeVisible();
    const toggleBox = (await heading.getByRole('switch').boundingBox())!;
    expect(buttonBox!.x).toBeGreaterThan(toggleBox.x + toggleBox.width);
    expect(
      Math.abs(buttonBox!.y + buttonBox!.height / 2 - toggleBox.y - toggleBox.height / 2),
    ).toBeLessThan(1);
    await page.screenshot({ path: testInfo.outputPath('remote-refresh-alignment.png') });
  });
}

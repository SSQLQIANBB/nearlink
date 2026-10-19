import { expect, test } from '@playwright/test';

for (const height of [720, 800]) {
  test(`远控全屏等比例铺满并恢复缩放 ${height}`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1280, height });
    await page.route((url) => url.pathname.startsWith('/api/'), (route) => route.fulfill({ json: {} }));
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await page.evaluate(async () => {
      const storePath = '/src/stores/remoteControlSession.ts';
      const piniaPath = '/src/stores/index.ts';
      const { useRemoteControlSessionStore } = await import(storePath);
      const { pinia } = await import(piniaPath);
      const session = useRemoteControlSessionStore(pinia);
      session.phase = 'active';
      session.device = { deviceId: '11111111-1111-4111-8111-111111111111', alias: '全屏测试电脑' };
      const canvas = document.createElement('canvas');
      canvas.width = 1920;
      canvas.height = 1080;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#1e3a5f';
      context.fillRect(0, 0, 1920, 1080);
      context.strokeStyle = '#6ee7b7';
      context.lineWidth = 16;
      context.strokeRect(8, 8, 1904, 1064);
      context.fillStyle = '#ffffff';
      context.font = '48px sans-serif';
      context.fillText('1920 × 1080 · 保持比例完整展示', 80, 130);
      session.stream = canvas.captureStream(10);
    });
    const video = page.locator('.remote-session video');
    await expect(video).toBeVisible();
    await page.evaluate(async () => {
      const storePath = '/src/stores/remoteControlSession.ts';
      const piniaPath = '/src/stores/index.ts';
      const { useRemoteControlSessionStore } = await import(storePath);
      const { pinia } = await import(piniaPath);
      const video = document.querySelector<HTMLVideoElement>('.remote-session video')!;
      video.srcObject = useRemoteControlSessionStore(pinia).stream;
      await video.play();
    });
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.videoWidth)).toBe(1920);
    await page.getByLabel('画面缩放', { exact: true }).selectOption('150');
    await page.getByRole('button', { name: '全屏显示远程画面' }).click();
    await expect(page.locator('.remote-session')).toHaveClass(/fullscreen/);
    expect(await page.evaluate(() => document.fullscreenElement?.classList.contains('remote-session'))).toBe(true);
    const geometry = await video.evaluate((node: HTMLVideoElement) => {
      const rect = node.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        viewportWidth: innerWidth, viewportHeight: innerHeight, fit: getComputedStyle(node).objectFit };
    });
    expect(geometry.x).toBe(0);
    expect(geometry.y).toBe(0);
    expect(geometry.width).toBe(geometry.viewportWidth);
    expect(geometry.height).toBe(geometry.viewportHeight);
    expect(geometry.fit).toBe('contain');
    await expect(page.locator('.remote-session footer')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('fullscreen.png') });
    await page.keyboard.press('Escape');
    await expect(page.locator('.remote-session')).not.toHaveClass(/fullscreen/);
    await expect(page.getByLabel('画面缩放', { exact: true })).toHaveValue('150');
    await expect(video).toHaveCSS('width', '2880px');
    await page.getByRole('button', { name: '全屏显示远程画面' }).click();
    await page.getByRole('button', { name: '结束协助', exact: true }).click();
    await expect(page.locator('.remote-session')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  });
}

import { expect, test, type Page } from '@playwright/test';
import { pinch } from './image-gestures';

test.use({ hasTouch: true });

const defaults = {
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
};

async function prepare(page: Page, server: { settings: typeof defaults }) {
  await page.addInitScript(() =>
    localStorage.setItem(
      '__STORAGE_PERSIST_AUTH_',
      JSON.stringify({ token: 'test', refreshToken: 'test' }),
    ),
  );
  await page.route('**/meeting/**', (route) => route.abort());
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname === '/api/auth/notification-settings') {
      if (route.request().method() === 'PUT')
        Object.assign(server.settings, route.request().postDataJSON());
      return route.fulfill({ json: { settings: server.settings } });
    }
    if (url.pathname === '/api/auth/me')
      return route.fulfill({
        json: {
          user: {
            id: 1,
            username: 'tester',
            nickname: '测试用户',
            ...route.request().postDataJSON(),
          },
        },
      });
    if (url.pathname === '/api/auth/email') return route.fulfill({ json: { email: null } });
    if (url.pathname === '/api/auth/users')
      return route.fulfill({ json: { users: [{ id: 2, username: '测试联系人' }] } });
    if (url.pathname === '/api/groups/7')
      return route.fulfill({
        json: {
          group: { id: 7, name: '测试群', ownerId: 1 },
          members: [{ id: 1, canSpeak: true }],
          myRole: 'owner',
          myCanSpeak: true,
        },
      });
    return route.fulfill({
      json: { messages: [], invitations: [], groups: [], count: 0, hasMore: false, cursors: {} },
    });
  });
}

test('账号通知设置在新浏览器会话恢复，保存失败保持原值', async ({ page, browser }, testInfo) => {
  const server = { settings: { ...defaults } };
  await prepare(page, server);
  await page.goto('/profile');
  await page.getByText('通知设置', { exact: true }).click();
  await page.getByRole('switch', { name: '私聊消息', exact: true }).click();
  await expect(page.getByRole('switch', { name: '私聊消息', exact: true })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  const second = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const other = await second.newPage();
    await prepare(other, server);
    await other.goto('/profile');
    await other.getByText('通知设置', { exact: true }).click();
    await expect(other.getByRole('switch', { name: '私聊消息', exact: true })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await other.route('**/api/auth/notification-settings', (route) =>
      route.fulfill({ status: 500, json: { error: '测试保存失败' } }),
    );
    await other.getByRole('switch', { name: '群组消息', exact: true }).click();
    await expect(other.getByRole('alert')).toContainText('保存失败');
    await expect(other.getByRole('switch', { name: '群组消息', exact: true })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(await other.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await other.screenshot({ path: testInfo.outputPath('mobile-notifications.png') });
  } finally {
    await second.close();
  }
});

for (const width of [1440, 390]) {
  test(`头像裁剪、取消及上传 ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await prepare(page, { settings: { ...defaults } });
    await page.goto('/profile');
    const image = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 800;
      canvas.height = 400;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#2563eb';
      context.fillRect(0, 0, 400, 400);
      context.fillStyle = '#f97316';
      context.fillRect(400, 0, 400, 400);
      context.fillStyle = '#22c55e';
      context.fillRect(390, 190, 20, 20);
      return canvas.toDataURL('image/png').split(',')[1]!;
    });
    const file = { name: 'crop.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') };
    let uploaded = false;
    let expectedJpeg: Buffer;
    await page.route('**/api/files/upload', (route) => {
      uploaded = true;
      const body = route.request().postDataBuffer()!.toString('latin1');
      expect(body).toContain('filename="avatar.jpg"');
      expect(body).toContain('image/jpeg');
      expect(body).toContain('avatar');
      expect(route.request().postDataBuffer()!.includes(expectedJpeg)).toBe(true);
      return route.fulfill({ json: { file: { fileUrl: '/cropped-avatar.jpg' } } });
    });
    await page.locator('input[type="file"]').setInputFiles(file);
    const crop = page.locator('.avatar-crop-modal');
    await expect(crop.getByRole('button', { name: '确认裁剪并上传' })).toBeEnabled();
    await crop.getByRole('button', { name: '取消', exact: true }).click();
    await expect(crop).toHaveCount(0);
    expect(uploaded).toBe(false);
    await page.locator('input[type="file"]').setInputFiles(file);
    await expect(crop.getByRole('button', { name: '确认裁剪并上传' })).toBeEnabled();
    await expect(crop.getByRole('slider')).toHaveCount(0);
    const canvas = crop.locator('canvas');
    const original = await canvas.evaluate((node) => (node as HTMLCanvasElement).toDataURL());
    await pinch(page, canvas, 80, 200);
    expect(await canvas.evaluate((node) => (node as HTMLCanvasElement).toDataURL())).not.toBe(
      original,
    );
    await pinch(page, canvas, 200, 80);
    await pinch(page, canvas, 80, 160);
    await expect(canvas).toHaveCSS('border-radius', '0px');
    await expect(crop.locator('.crop-mask')).toHaveCSS('pointer-events', 'none');
    await expect(crop.locator('.crop-mask')).toHaveCSS(
      'box-shadow',
      'rgba(0, 0, 0, 0.55) 0px 0px 0px 200px',
    );
    const bounds = (await crop.locator('canvas').boundingBox())!;
    await page.mouse.move(bounds.x + 100, bounds.y + 100);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 170, bounds.y + 100);
    await page.mouse.up();
    expect(
      await crop
        .locator('canvas')
        .evaluate((canvas) =>
          Array.from(
            (canvas as HTMLCanvasElement).getContext('2d')!.getImageData(256, 256, 1, 1).data,
          ),
        ),
    ).toEqual([37, 99, 235, 255]);
    await page.screenshot({ path: testInfo.outputPath('avatar-crop.png') });
    await pinch(page, canvas, 200, 40);
    await pinch(page, canvas, 200, 80);
    const smallImageBounds = () =>
      canvas.evaluate((node) => {
        const pixels = (node as HTMLCanvasElement)
          .getContext('2d')!
          .getImageData(0, 0, 512, 512).data;
        let left = 512,
          right = 0,
          top = 512,
          bottom = 0;
        for (let y = 0; y < 512; y++) {
          for (let x = 0; x < 512; x++) {
            const index = (y * 512 + x) * 4;
            if (pixels[index] === 255 && pixels[index + 1] === 255 && pixels[index + 2] === 255)
              continue;
            left = Math.min(left, x);
            right = Math.max(right, x);
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
          }
        }
        return { left, top, width: right - left + 1, height: bottom - top + 1 };
      });
    const small = await smallImageBounds();
    expect(small.width).toBeGreaterThanOrEqual(256);
    expect(small.width).toBeLessThanOrEqual(257);
    expect(small.height).toBe(128);
    await page.mouse.move(bounds.x + 140, bounds.y + 140);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 140, bounds.y + 180);
    await page.mouse.up();
    const moved = await smallImageBounds();
    expect(moved.top).toBeGreaterThan(small.top);
    expect(moved.height).toBeGreaterThanOrEqual(128);
    expect(moved.height).toBeLessThanOrEqual(129);
    await page.screenshot({ path: testInfo.outputPath('avatar-crop-small.png') });
    expectedJpeg = Buffer.from(
      await canvas.evaluate(
        (node) => (node as HTMLCanvasElement).toDataURL('image/jpeg', 0.9).split(',')[1]!,
      ),
      'base64',
    );
    await crop.getByRole('button', { name: '确认裁剪并上传' }).click();
    await expect(crop).toHaveCount(0);
    expect(uploaded).toBe(true);
    const save = page.waitForRequest(
      (request) => request.url().endsWith('/api/auth/me') && request.method() === 'PUT',
    );
    await page.getByRole('button', { name: '保存修改' }).click();
    expect((await save).postDataJSON().avatar).toBe('/cropped-avatar.jpg');
    await expect(page.getByText('保存成功', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '保存修改' })).toHaveCSS('--n-color', '#2563eb');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

for (const path of ['/group-chat/7', '/remote']) {
  test(`图片预览支持双指缩放、拖动、关闭后重新打开 ${path}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await prepare(page, { settings: { ...defaults } });
    await page.route('https://chat-images.test/preview.svg', (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#2563eb"/><circle cx="400" cy="300" r="100" fill="#f97316"/></svg>',
      }),
    );
    await page.route(/\/api\/messages\/(group\/7\?|private\?)/, (route) =>
      route.fulfill({
        json: {
          messages: [
            {
              id: 1,
              userId: 2,
              fromUserId: 2,
              toUserId: 1,
              groupId: 7,
              sender: { id: 2, username: '测试联系人' },
              message: '',
              messageType: 'image',
              createdAt: '2026-09-24T04:00:00Z',
              media: { url: 'https://chat-images.test/preview.svg', mimeType: 'image/svg+xml' },
            },
          ],
          hasMore: false,
        },
      }),
    );
    await page.goto(path);
    if (path === '/remote') {
      await page.getByRole('button', { name: '打开联系人列表', exact: true }).click();
      await page.locator('.contact-item').first().click();
    }
    await page.getByRole('button', { name: '聊天图片', exact: true }).click();
    const preview = page.getByRole('dialog', { name: '图片预览', exact: true });
    const viewport = preview.locator('.image-preview__viewport');
    const image = preview.locator('img');
    await expect(image).toBeVisible();
    await pinch(page, viewport, 80, 200);
    const matrix = () =>
      image.evaluate((node) => {
        const transform = new DOMMatrix(getComputedStyle(node).transform);
        return { scale: transform.a, x: transform.e };
      });
    expect((await matrix()).scale).toBeCloseTo(2.5, 1);
    const box = (await viewport.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2);
    await page.mouse.up();
    expect((await matrix()).x).toBeGreaterThan(40);
    await pinch(page, viewport, 200, 80);
    expect((await matrix()).scale).toBeCloseTo(1, 1);
    await pinch(page, viewport, 80, 200);
    await page.screenshot({ path: testInfo.outputPath('image-preview-pinch.png') });
    expect(await page.evaluate(() => visualViewport!.scale)).toBe(1);
    await preview.getByRole('button', { name: '关闭图片预览' }).click();
    await expect(preview).toHaveCount(0);
    await page.getByRole('button', { name: '聊天图片', exact: true }).click();
    await expect(image).toBeVisible();
    expect((await matrix()).scale).toBe(1);
    await viewport.hover();
    await page.mouse.wheel(0, -350);
    await expect.poll(async () => (await matrix()).scale).toBeGreaterThan(1);
    await preview.getByRole('button', { name: '重置', exact: true }).click();
    expect((await matrix()).scale).toBe(1);
    await preview.getByRole('button', { name: '向右旋转' }).click();
    await expect(image).toHaveCSS('transform', 'matrix(0, 1, -1, 0, 0, 0)');
    await page.keyboard.press('Escape');
    await expect(preview).toHaveCount(0);
  });
}

test('损坏图片不上传，上传失败保留裁剪窗口并允许重试', async ({ page }) => {
  await prepare(page, { settings: { ...defaults } });
  await page.goto('/profile');
  const input = page.locator('input[type="file"]');
  await input.setInputFiles({
    name: 'broken.png',
    mimeType: 'image/png',
    buffer: Buffer.from('broken image'),
  });
  const crop = page.locator('.avatar-crop-modal');
  await expect(crop.getByRole('alert')).toContainText('图片无法读取');
  await expect(crop.getByRole('button', { name: '确认裁剪并上传' })).toBeDisabled();
  await crop.getByRole('button', { name: '取消', exact: true }).click();
  const png = await page.evaluate(
    () => document.createElement('canvas').toDataURL().split(',')[1]!,
  );
  await input.setInputFiles({
    name: 'valid.png',
    mimeType: 'image/png',
    buffer: Buffer.from(png, 'base64'),
  });
  let attempts = 0;
  await page.route('**/api/files/upload', (route) => {
    attempts++;
    return route.fulfill(
      attempts === 1
        ? { status: 500, json: { error: '测试上传失败' } }
        : { json: { file: { fileUrl: '/cropped-avatar.jpg' } } },
    );
  });
  await crop.getByRole('button', { name: '确认裁剪并上传' }).click();
  await expect(page.getByText('上传失败: 测试上传失败', { exact: true })).toBeVisible();
  await expect(crop).toBeVisible();
  await crop.getByRole('button', { name: '确认裁剪并上传' }).click();
  await expect(crop).toHaveCount(0);
  expect(attempts).toBe(2);
});

test.describe('移动端首次触摸发送', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  for (const path of ['/remote', '/group-chat/7']) {
    test(path, async ({ page }, testInfo) => {
      await prepare(page, { settings: { ...defaults } });
      await page.goto(path);
      if (path === '/remote') {
        await page.getByRole('button', { name: '打开联系人列表', exact: true }).click();
        await page.locator('.contact-item').first().click();
      }
      const editor = page.getByRole('textbox', { name: '消息', exact: true });
      await editor.fill('首次点击发送');
      await page.getByRole('button', { name: '发送', exact: true }).tap();
      await expect(page.getByText('首次点击发送', { exact: true })).toHaveCount(1);
      await expect(editor).toBeEmpty();
      await expect(editor).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath('mobile-send.png') });
    });
  }
});

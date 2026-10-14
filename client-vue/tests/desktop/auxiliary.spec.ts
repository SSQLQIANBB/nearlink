import { test, expect, type Page } from '@playwright/test';

// 浏览器层模拟原生 IPC；真实窗口装饰和设备权限仍由原生验收覆盖。
async function auxiliaryPage(
  page: Page,
  kind: 'image' | 'audio' | 'screen' | 'group-audio' | 'group-screen',
) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const sockets: string[] = [];
  page.on('websocket', (socket) => sockets.push(socket.url()));
  await page.route('**/api/**', (route) =>
    route.fulfill({
      json: {
        settings: {},
        group: { id: 7, name: '测试群组', ownerId: 1 },
        members: [{ id: 1, username: 'tester', role: 'owner', canSpeak: true }],
        myRole: 'owner',
        myCanSpeak: true,
      },
    }),
  );
  await page.addInitScript((kind) => {
    const runtime = window as any;
    runtime.isTauri = true;
    const callbacks = new Map<number, Function>();
    const listeners = new Map<string, { id: number; handler: number }>();
    let nextId = 0;
    runtime.__windowMessages = [];
    runtime.__mediaStops = 0;
    runtime.__displayRequests = 0;
    runtime.__shareCommands = [];
    runtime.__nativeEvent = (event: string, payload: unknown) => {
      const listener = listeners.get(event);
      if (listener) callbacks.get(listener.handler)?.({ event, id: listener.id, payload });
    };
    runtime.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    runtime.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: kind === 'image' ? 'image-preview' : 'media-call' },
        currentWebview: { label: kind === 'image' ? 'image-preview' : 'media-call' },
      },
      transformCallback: (handler: Function) => {
        const id = ++nextId;
        callbacks.set(id, handler);
        return id;
      },
      invoke: async (command: string, args: any) => {
        if (command.startsWith('screen_share_')) {
          runtime.__shareCommands.push({ command, args });
          if (command === 'screen_share_sources')
            return [
              { id: 'display:1', kind: 'display', name: '桌面 1', app: '桌面' },
              { id: 'window:1', kind: 'window', name: '项目文档 - 编辑器', app: '编辑器' },
              { id: 'window:2', kind: 'window', name: '工作浏览器', app: '浏览器' },
            ];
          if (command === 'screen_share_start') return 11;
          if (command === 'screen_share_preview' && args.id === 'window:2')
            throw new Error('系统不允许采集此窗口');
          if (command === 'screen_share_preview' || command === 'screen_share_frame') {
            const canvas = document.createElement('canvas');
            canvas.width = 640;
            canvas.height = 400;
            const context = canvas.getContext('2d')!;
            context.fillStyle = '#1e293b';
            context.fillRect(0, 0, 640, 400);
            context.fillStyle = '#338bff';
            context.fillRect(25, 25, 140, 350);
            context.fillStyle = '#eee';
            context.font = '24px sans-serif';
            context.fillText('NearLink 共享预览', 200, 80);
            const blob = await new Promise<Blob>((resolve) =>
              canvas.toBlob((blob) => resolve(blob!), 'image/jpeg'),
            );
            return blob.arrayBuffer();
          }
          return;
        }
        if (command === 'plugin:event|listen') {
          const id = ++nextId;
          listeners.set(args.event, { id, handler: args.handler });
          return id;
        }
        if (command === 'plugin:event|unlisten') {
          listeners.delete(args.event);
          return;
        }
        if (command === 'plugin:event|emit_to') {
          runtime.__windowMessages.push(args.payload.data);
          if (args.payload.data.type === 'hello') {
            const src =
              'data:image/svg+xml,' +
              encodeURIComponent(
                '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#2563eb"/><circle cx="320" cy="200" r="100" fill="#fff"/></svg>',
              );
            const content =
              kind === 'image'
                ? { kind: 'image', src, alt: '测试图片' }
                : kind.startsWith('group-')
                  ? {
                      kind: 'group',
                      path: `/${kind}/7`,
                      groupId: 7,
                      deviceType: kind === 'group-screen' ? 2 : 3,
                    }
                  : {
                      kind: 'private',
                      request: {
                        user: { id: 2, socketId: 'peer', nickname: '测试联系人' },
                        type: kind === 'screen' ? 1 : 2,
                      },
                    };
            queueMicrotask(() =>
              runtime.__nativeEvent('nearlink-auxiliary', {
                id: args.payload.id,
                data: {
                  type: 'bootstrap',
                  bootstrap: {
                    content,
                    token: 'test',
                    refreshToken: 'test',
                    user: { id: 1, username: 'tester' },
                    socketId: 'main-socket',
                    connected: true,
                    authenticated: true,
                  },
                },
              }),
            );
          }
          return;
        }
        if (command.startsWith('plugin:notification|')) return false;
        return null;
      },
    };
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => {
        const audio = new AudioContext().createMediaStreamDestination().stream;
        for (const track of audio.getTracks()) {
          const stop = track.stop.bind(track);
          track.stop = () => {
            runtime.__mediaStops++;
            stop();
          };
        }
        return audio;
      },
    });
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      value: async () => {
        runtime.__displayRequests++;
        throw new DOMException('Cancelled by test', 'NotAllowedError');
      },
    });
  }, kind);
  const path = kind.startsWith('group-')
    ? `/${kind}/7`
    : `/desktop-${kind === 'image' ? 'image' : 'private'}`;
  await page.goto(`/?auxiliary=test-id#${path}`);
  return { errors, sockets };
}

test('独立图片窗口铺满内容区，缩放旋转与关闭可用', async ({ page }, testInfo) => {
  const { errors, sockets } = await auxiliaryPage(page, 'image');
  const preview = page.getByRole('dialog', { name: '图片预览' });
  await expect(preview).toBeVisible();
  await expect(page.getByAltText('测试图片')).toBeVisible();
  await page.getByRole('button', { name: '向右旋转' }).click();
  await expect(page.getByAltText('测试图片')).toHaveAttribute('style', /rotate\(90deg\)/);
  await page.setViewportSize({ width: 640, height: 480 });
  await expect(page.getByRole('button', { name: '关闭图片预览' })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('auxiliary-image.png') });
  await page.getByRole('button', { name: '关闭图片预览' }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__windowMessages.some((data: any) => data.type === 'closed'),
      ),
    )
    .toBe(true);
  expect(sockets).toEqual([]);
  expect(errors).toEqual([]);
});

test('群组语音独立窗口挂断释放轨道并离开媒体会话', async ({ page }) => {
  const { errors, sockets } = await auxiliaryPage(page, 'group-audio');
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__windowMessages.some((data: any) => data.event === 'group_call_start'),
      ),
    )
    .toBe(true);
  await page.evaluate(() => (window as any).__nativeEvent('tauri://close-requested', null));
  await expect.poll(() => page.evaluate(() => (window as any).__mediaStops)).toBe(1);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__windowMessages.some((data: any) => data.event === 'leave_group_call'),
      ),
    )
    .toBe(true);
  expect(sockets).toEqual([]);
  expect(errors).toEqual([]);
});

test('群组共享窗口选择取消后仍可重新选择', async ({ page }) => {
  const { errors, sockets } = await auxiliaryPage(page, 'group-screen');
  const start = page.getByRole('button', { name: '开始共享', exact: true });
  await expect(start).toBeVisible();
  expect(await page.evaluate(() => (window as any).__displayRequests)).toBe(0);
  await start.click();
  await expect(page.getByRole('dialog', { name: '选择共享内容' })).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(start).toBeVisible();
  await start.click();
  await expect(page.getByRole('dialog', { name: '选择共享内容' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__displayRequests)).toBe(0);
  expect(sockets).toEqual([]);
  expect(errors).toEqual([]);
});

test('独立语音窗口使用主窗口信令，原生关闭先停止音轨', async ({ page }, testInfo) => {
  const { errors, sockets } = await auxiliaryPage(page, 'audio');
  await expect(page.getByText('等待对方接听…')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__windowMessages.some((data: any) => data.event === 'webrtc_call_request'),
      ),
    )
    .toBe(true);
  await page.screenshot({ path: testInfo.outputPath('auxiliary-audio.png') });
  await page.evaluate(() => (window as any).__nativeEvent('tauri://close-requested', null));
  await expect.poll(() => page.evaluate(() => (window as any).__mediaStops)).toBe(1);
  const messages = await page.evaluate(() => (window as any).__windowMessages);
  expect(messages.findIndex((data: any) => data.event === 'webrtc_hangup')).toBeLessThan(
    messages.findIndex((data: any) => data.type === 'closed'),
  );
  expect(sockets).toEqual([]);
  expect(errors).toEqual([]);
});

test('屏幕共享进入原生源选择，取消后关闭会话且不调用浏览器选择器', async ({ page }) => {
  const { errors } = await auxiliaryPage(page, 'screen');
  await expect(page.getByRole('dialog', { name: '选择共享内容' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__displayRequests)).toBe(0);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__windowMessages.some((data: any) => data.type === 'closed'),
      ),
    )
    .toBe(true);
  expect(errors).toEqual([]);
});

test('原生共享源可筛选和选择，停止事件结束采集并挂断', async ({ page }, testInfo) => {
  const { errors } = await auxiliaryPage(page, 'screen');
  const picker = page.getByRole('dialog', { name: '选择共享内容' });
  await expect(picker).toBeVisible();
  await page.getByRole('button', { name: '编辑器', exact: true }).click();
  await expect(page.getByRole('button', { name: /工作浏览器/ })).toHaveCount(0);
  await page.getByRole('button', { name: /项目文档 - 编辑器/ }).click();
  await expect(page.getByRole('button', { name: /项目文档 - 编辑器/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(picker.locator('img')).toHaveCount(2);
  await picker.locator('.share-picker__content').evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: testInfo.outputPath('screen-picker.png') });
  await page.setViewportSize({ width: 640, height: 480 });
  await expect(page.getByRole('button', { name: '开始共享', exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('screen-picker-small.png') });
  await page.getByRole('button', { name: '开始共享', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__shareCommands.map((c: any) => c.command)))
    .toContain('screen_share_present');
  expect(
    await page.evaluate(
      () =>
        (window as any).__shareCommands.find((c: any) => c.command === 'screen_share_start').args
          .id,
    ),
  ).toBe('window:1');
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__windowMessages.some((d: any) => d.event === 'webrtc_call_request'),
      ),
    )
    .toBe(true);
  await page.evaluate(() => (window as any).__nativeEvent('desktop-share-stop', 11));
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__windowMessages.some((d: any) => d.event === 'webrtc_hangup'),
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__shareCommands.some((c: any) => c.command === 'screen_share_stop'),
      ),
    )
    .toBe(true);
  expect(await page.evaluate(() => (window as any).__displayRequests)).toBe(0);
  expect(errors).toEqual([]);
});

test('置顶共享控制条仅提供结束共享操作', async ({ page }, testInfo) => {
  await auxiliaryPage(page, 'image');
  await page.setViewportSize({ width: 400, height: 44 });
  await page.goto('/?share-overlay=toolbar&token=11');
  await expect(page.getByText('正在共享屏幕')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('share-toolbar.png') });
  await expect(page.getByRole('button', { name: '恢复通话窗口' })).toHaveCount(0);
  await page.getByRole('button', { name: '结束共享' }).click();
  expect(await page.evaluate(() => (window as any).__shareCommands)).toEqual([
    { command: 'screen_share_stop', args: { token: 11 } },
  ]);
});

test('不可采集的窗口显示原因并禁用选择', async ({ page }) => {
  await auxiliaryPage(page, 'screen');
  const source = page.getByRole('button', { name: /工作浏览器/ });
  await expect(source).toBeDisabled();
  await expect(source).toContainText('无法共享此窗口');
  await expect(page.getByRole('button', { name: '开始共享', exact: true })).toBeEnabled();
});

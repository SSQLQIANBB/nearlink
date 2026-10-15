import { test, expect, type Page } from '@playwright/test';

// 浏览器层模拟原生 IPC；真实窗口装饰和设备权限仍由原生验收覆盖。
async function auxiliaryPage(
  page: Page,
  kind: 'image' | 'audio' | 'screen' | 'group-audio' | 'group-screen',
  startScreen = true,
) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const sockets: string[] = [];
  page.on('websocket', (socket) => sockets.push(socket.url()));
  await page.route('**/api/**', (route) =>
    route.fulfill({
      json: {
        settings: {},
        users: [{ id: 2, username: 'peer', nickname: '测试联系人' }],
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
          if (args.event.startsWith('desktop-share-quality')) {
            runtime.__qualityMessages ??= [];
            runtime.__qualityMessages.push({ event: args.event, payload: args.payload });
            return;
          }
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
                : kind === 'screen'
                  ? {
                      kind: 'screen',
                      path: '/screen-share/private/2',
                      scope: { kind: 'private', peerId: 2 },
                    }
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
                          type: 2,
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
  const path =
    kind === 'screen'
      ? '/screen-share/private/2'
      : kind.startsWith('group-')
        ? `/${kind}/7`
        : `/desktop-${kind === 'image' ? 'image' : 'private'}`;
  await page.goto(`/?auxiliary=test-id#${path}`);
  if (kind === 'screen' && startScreen)
    await page.getByRole('button', { name: '开始共享', exact: true }).click();
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

test('个人共享复用群组源选择，取消后留在共享页且不调用浏览器选择器', async ({ page }) => {
  const { errors } = await auxiliaryPage(page, 'screen');
  await expect(page.getByRole('dialog', { name: '选择共享内容' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__displayRequests)).toBe(0);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始共享', exact: true })).toBeVisible();
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
  await expect(picker.getByRole('button', { name: '开始共享', exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('screen-picker-small.png') });
  await picker.getByRole('button', { name: '开始共享', exact: true }).click();
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
        (window as any).__windowMessages.some(
          (d: any) => d.event === 'screen_share' && d.args[0].action === 'start',
        ),
      ),
    )
    .toBe(true);
  await page.evaluate(() => (window as any).__nativeEvent('desktop-share-stop', 11));
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__windowMessages.some(
          (d: any) => d.event === 'screen_share' && d.args[0].action === 'end',
        ),
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

test('置顶共享控制条支持清晰度和结束共享，不显示恢复窗口', async ({ page }, testInfo) => {
  await auxiliaryPage(page, 'image');
  await page.setViewportSize({ width: 400, height: 44 });
  await page.goto('/?share-overlay=toolbar&token=11');
  await expect(page.getByText('正在共享屏幕')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window as any).__qualityMessages?.length ?? 0))
    .toBe(1);
  await page.evaluate(() =>
    (window as any).__nativeEvent('desktop-share-quality-state', { token: 11, quality: 'high' }),
  );
  await expect(page.getByRole('combobox', { name: '共享清晰度' })).toBeInViewport();
  await page.getByRole('combobox', { name: '共享清晰度' }).selectOption('ultra');
  expect(await page.evaluate(() => (window as any).__qualityMessages.at(-1))).toEqual({
    event: 'desktop-share-quality',
    payload: { token: 11, quality: 'ultra' },
  });
  await page.evaluate(() =>
    (window as any).__nativeEvent('desktop-share-quality-state', { token: 11, quality: 'ultra' }),
  );
  await expect(page.getByRole('combobox', { name: '共享清晰度' })).toHaveValue('ultra');
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
  await expect(
    page
      .getByRole('dialog', { name: '选择共享内容' })
      .getByRole('button', { name: '开始共享', exact: true }),
  ).toBeEnabled();
});

test('桌面共享通过工具条信号调整下一帧质量，保持原生会话和麦克风', async ({ page }) => {
  const { errors } = await auxiliaryPage(page, 'screen');
  await page
    .getByRole('dialog', { name: '选择共享内容' })
    .getByRole('button', { name: '开始共享', exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__windowMessages.some(
          (data: any) => data.event === 'screen_share' && data.args[0].action === 'start',
        ),
      ),
    )
    .toBe(true);
  await page.evaluate(() =>
    (window as any).__nativeEvent('desktop-share-quality', { token: 11, quality: 'ultra' }),
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__shareCommands.some(
          (command: any) =>
            command.command === 'screen_share_frame' && command.args.maxEdge === 2560,
        ),
      ),
    )
    .toBe(true);
  const state = await page.evaluate(() => ({
    starts: (window as any).__shareCommands.filter(
      (command: any) => command.command === 'screen_share_start',
    ).length,
    stops: (window as any).__shareCommands.filter(
      (command: any) => command.command === 'screen_share_stop',
    ).length,
    ended: (window as any).__windowMessages.some(
      (data: any) => data.event === 'screen_share' && data.args[0].action === 'end',
    ),
    mediaStops: (window as any).__mediaStops,
  }));
  expect(state).toEqual({ starts: 1, stops: 0, ended: false, mediaStops: 0 });
  await expect(page.getByRole('dialog', { name: '选择共享内容' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('桌面观看方在媒体独立窗口加入共享，不创建采集和边框', async ({ page }) => {
  const { errors } = await auxiliaryPage(page, 'screen', false);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__windowMessages.some(
          (data: any) => data.event === 'screen_share' && data.args[0].action === 'state',
        ),
      ),
    )
    .toBe(true);
  await page.evaluate(() =>
    (window as any).__nativeEvent('nearlink-auxiliary', {
      id: 'test-id',
      data: {
        type: 'signal',
        event: 'group_call_state',
        args: [
          {
            groupId: 'private:1:2',
            sessions: {
              screen: {
                groupId: 'private:1:2',
                type: 'screen',
                channelId: 'private:1:2:screen',
                ownerUserId: 2,
                ownerSocketId: 'peer',
                startedAt: '2026-10-15T10:00:00.000Z',
              },
            },
          },
        ],
      },
    }),
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__windowMessages.some(
          (data: any) => data.event === 'screen_share' && data.args[0].action === 'join',
        ),
      ),
    )
    .toBe(true);
  expect(
    await page.evaluate(() => (window as any).__TAURI_INTERNALS__.metadata.currentWindow.label),
  ).toBe('media-call');
  expect(await page.evaluate(() => (window as any).__shareCommands)).toEqual([]);
  expect(await page.evaluate(() => (window as any).__displayRequests)).toBe(0);
  await expect(page.getByRole('dialog', { name: '选择共享内容' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

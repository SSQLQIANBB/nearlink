import { expect, test, type Page } from '@playwright/test';

const authenticatedRoutes = [
  '/remote',
  '/profile',
  '/groups',
  '/group-chat/7',
  '/group-video/7',
  '/group-screen/7',
];

const publicRoutes = ['/login', '/chat', '/socket', '/share'];

async function preparePage(page: Page, userId = 1) {
  await page.route(/\/meeting(?:\/|\?|$)/, (route) => route.abort());
  await page.addInitScript(
    ({ authenticatedUserId }) => {
      localStorage.setItem('token', 'layout-test-token');
      localStorage.setItem(
        '__STORAGE_PERSIST_AUTH_',
        JSON.stringify({ token: 'layout-test-token', refreshToken: 'layout-refresh-token' }),
      );
      localStorage.setItem(
        'user',
        JSON.stringify({
          id: authenticatedUserId,
          username: authenticatedUserId === 1 ? 'owner' : 'member',
          nickname: authenticatedUserId === 1 ? '测试用户' : '成员二',
          status: 'online',
        }),
      );

      const stream = new MediaStream();
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: async () => stream,
          getDisplayMedia: async () => {
            (window as any).__screenCaptureCount = ((window as any).__screenCaptureCount || 0) + 1;
            return stream;
          },
        },
      });

      class PeerConnectionStub {
        addTrack() {}
        close() {}
        setLocalDescription() {
          return Promise.resolve();
        }
        setRemoteDescription() {
          return Promise.resolve();
        }
        addIceCandidate() {
          return Promise.resolve();
        }
        createOffer() {
          return Promise.resolve({ type: 'offer', sdp: '' });
        }
        createAnswer() {
          return Promise.resolve({ type: 'answer', sdp: '' });
        }
      }
      Object.defineProperty(window, 'RTCPeerConnection', {
        configurable: true,
        value: PeerConnectionStub,
      });
    },
    { authenticatedUserId: userId },
  );

  await page.route(/\/api\/(auth|groups|messages|invitations)(?:\/|\?|$)/, async (route) => {
    const url = route.request().url();
    let body: Record<string, unknown> = {};

    if (url.includes('/api/auth/me')) {
      body = {
        user: {
          id: userId,
          username: userId === 1 ? 'owner' : 'member',
          nickname: userId === 1 ? '测试用户' : '成员二',
          status: 'online',
        },
      };
    } else if (url.includes('/api/groups/my')) {
      body = {
        groups: [
          {
            id: 7,
            name: '响应式测试群组',
            description: '用于移动端布局检查',
            ownerId: 1,
            role: 'owner',
            memberCount: 2,
          },
        ],
      };
    } else if (url.includes('/api/groups/7')) {
      body = {
        group: { id: 7, name: '响应式测试群组', ownerId: 1 },
        members: [
          { id: 1, username: 'owner', nickname: '测试用户', role: 'owner', canSpeak: true },
          { id: 2, username: 'member', nickname: '成员二', role: 'member', canSpeak: true },
        ],
        myRole: 'owner',
        myCanSpeak: true,
      };
    } else if (url.includes('/api/messages/group/7')) {
      body = { messages: [], hasMore: false };
    } else if (url.includes('/api/auth/users')) {
      body = { users: [] };
    } else if (url.includes('/api/messages')) {
      body = { messages: [], count: 0, hasMore: false };
    } else {
      body = { users: [], messages: [] };
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const viewportWidth = document.documentElement.clientWidth;
        const roots = [
          document.documentElement,
          document.body,
          document.querySelector('#app'),
        ].filter((element): element is Element => Boolean(element));
        return roots.every((element) => element.scrollWidth <= viewportWidth + 1);
      }),
    )
    .toBe(true);
}

test.describe('响应式布局', () => {
  test('手机登录表单只在超出视口时滚动', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/login');
    const card = page.locator('.login-card');
    await expect(card).toBeVisible();
    const box = await card.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.abs(box!.y + box!.height / 2 - 812 / 2)).toBeLessThan(24);

    const loginPage = page.locator('.login-page');
    const expectNoScroll = async () => {
      await expect
        .poll(() => loginPage.evaluate((element) => element.scrollHeight - element.clientHeight))
        .toBe(0);
      expect(await loginPage.evaluate((element) => getComputedStyle(element).scrollbarWidth)).toBe(
        'none',
      );
    };
    await expectNoScroll();
    await page.getByText('找回密码', { exact: true }).first().click();
    await expectNoScroll();
    await page.getByText('注册', { exact: true }).first().click();
    await expectNoScroll();

    await page.setViewportSize({ width: 375, height: 500 });
    await expect
      .poll(() => loginPage.evaluate((element) => element.scrollHeight > element.clientHeight))
      .toBe(true);
    const submit = page.locator('.n-tab-pane:visible .n-button').last();
    await submit.scrollIntoViewIfNeeded();
    await expect(submit).toBeInViewport();
  });

  test('个人中心通知设置保存后控制消息横幅与测试通知', async ({ page }) => {
    await preparePage(page);
    await page.addInitScript(() => {
      (window as any).__desktopNotifications = [];
      Object.defineProperty(window, 'Notification', {
        configurable: true,
        value: class {
          static permission = 'granted';
          static requestPermission = async () => 'granted';
          constructor(title: string, options: NotificationOptions) {
            (window as any).__desktopNotifications.push({ title, body: options.body });
          }
          close() {}
        },
      });
    });
    await page.goto('/profile');
    await page.getByText('通知设置', { exact: true }).click();
    const switches = page.locator('.n-tab-pane:visible .n-switch');
    await expect(switches).toHaveCount(7);
    await switches.nth(2).click(); // 隐藏消息预览
    await switches.nth(3).click(); // 关闭私聊提醒
    await switches.nth(5).click(); // 关闭来电提醒
    await switches.nth(6).click(); // 关闭邀请提醒
    expect(
      await page.evaluate(() => JSON.parse(localStorage.getItem('notify_settings') || '{}')),
    ).toMatchObject({
      messagePreview: false,
      notifyPrivateMessage: false,
      notifyCall: false,
      notifyInvitation: false,
    });

    await page.goto('/groups');
    await page.evaluate(async () => {
      const { useSocketStore } = await import('/src/stores/socket.ts' as string);
      useSocketStore()
        .socket?.listeners('private_message')
        .forEach((listener: Function) =>
          listener({
            id: 911,
            fromUserId: 2,
            sender: { id: 2, nickname: '小明' },
            message: '秘密内容',
          }),
        );
    });
    await expect(page.locator('.n-notification')).toHaveCount(0);
    await expect(page.locator('.global-unread-shortcut__badge')).toHaveText('1');

    await page.goto('/profile');
    await page.getByText('通知设置', { exact: true }).click();
    await page.locator('.n-tab-pane:visible .n-switch').nth(3).click();
    await page.goto('/groups');
    await page.evaluate(async () => {
      const { useSocketStore } = await import('/src/stores/socket.ts' as string);
      useSocketStore()
        .socket?.listeners('private_message')
        .forEach((listener: Function) =>
          listener({
            id: 912,
            fromUserId: 2,
            sender: { id: 2, nickname: '小明' },
            message: '秘密内容',
          }),
        );
    });
    await expect(page.locator('.n-notification .global-message-link')).toHaveText(
      '内容：收到一条私聊消息',
    );

    await page.goto('/profile');
    await page.getByText('通知设置', { exact: true }).click();
    await page.locator('.n-tab-pane:visible .n-switch').nth(0).click();
    await expect(page.getByRole('button', { name: '发送测试' })).toBeDisabled();
    await page.locator('.n-tab-pane:visible .n-switch').nth(0).click();
    await page.getByRole('button', { name: '发送测试' }).click();
    expect(await page.evaluate(() => (window as any).__desktopNotifications)).toContainEqual({
      title: '测试通知',
      body: '这是一条测试通知，您的通知设置已生效！',
    });
  });

  test('新消息提示文字清晰可见，联系人未读徽标靠右', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await preparePage(page);
    await page.goto('/remote');
    await page.evaluate(async () => {
      const { useSocketStore } = await import('/src/stores/socket.ts' as string);
      const socket = useSocketStore().socket;
      if (!socket) throw new Error('Socket 尚未初始化');
      socket.listeners('private_message').forEach((listener: Function) =>
        listener({
          id: 901,
          fromUserId: 2,
          sender: { id: 2, nickname: '小明' },
          message: '你好',
        }),
      );
    });

    const title = page.locator('.n-notification .global-message-title');
    const content = page.locator('.n-notification .global-message-link');
    await expect(title).toHaveText('小明：消息');
    await expect(content).toHaveText('内容：你好');
    expect(await title.evaluate((element) => getComputedStyle(element).color)).toBe(
      'rgb(248, 250, 252)',
    );
    expect(await content.evaluate((element) => getComputedStyle(element).color)).toBe(
      'rgb(219, 234, 254)',
    );

    await page.getByRole('button', { name: '打开联系人列表' }).click();
    const badge = page.locator('.contact-unread-badge');
    await expect(badge).toHaveText('1');
    const header = badge.locator('xpath=..');
    const headerBox = await header.boundingBox();
    const badgeBox = await badge.boundingBox();
    expect(headerBox).not.toBeNull();
    expect(badgeBox).not.toBeNull();
    expect(badgeBox!.x).toBeGreaterThan(headerBox!.x + headerBox!.width / 2);
  });

  test('桌面联系人列表滚动区填满侧栏底部', async ({ page }) => {
    await page.setViewportSize({ width: 915, height: 629 });
    await preparePage(page);
    await page.goto('/remote');

    const sidebar = page.locator('.remote-sidebar');
    const scrollbar = page.locator('.n-tab-pane:visible .n-scrollbar');
    await expect(sidebar).toBeVisible();
    await expect(scrollbar).toBeVisible();

    const sidebarBox = await sidebar.boundingBox();
    const scrollbarBox = await scrollbar.boundingBox();
    expect(sidebarBox).not.toBeNull();
    expect(scrollbarBox).not.toBeNull();
    expect(
      Math.abs(scrollbarBox!.y + scrollbarBox!.height - sidebarBox!.y - sidebarBox!.height),
    ).toBeLessThanOrEqual(1);
  });

  test('标注工具栏默认贴近视口底部，可拖动到不遮挡画面的位置', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await preparePage(page);
    await page.goto('/groups');
    await page.getByRole('button', { name: '发起屏幕共享' }).click();
    await page.getByRole('button', { name: '开启标注' }).click();
    const toolbar = page.getByRole('toolbar', { name: '共享标注工具栏' });
    await expect(toolbar).toBeVisible();
    const initial = await toolbar.boundingBox();
    expect(initial).not.toBeNull();
    expect(initial!.y + initial!.height).toBeGreaterThan(780);
    const handle = await toolbar.locator('.toolbar-title').boundingBox();
    expect(handle).not.toBeNull();
    await page.mouse.move(handle!.x + 35, handle!.y + handle!.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle!.x + 65, handle!.y - 100, { steps: 4 });
    await page.mouse.up();
    const moved = await toolbar.boundingBox();
    expect(moved!.y).toBeLessThan(initial!.y - 50);
    expect(moved!.x).toBeGreaterThanOrEqual(0);
  });

  test('群列表点击发起共享后立即申请屏幕并进入共享状态', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await preparePage(page);
    await page.goto('/groups');
    await page.getByRole('button', { name: '发起屏幕共享' }).click();
    await expect(page).toHaveURL(/\/group-screen\/7$/);
    await expect(page.getByRole('button', { name: '停止共享' })).toBeVisible();
    expect(await page.evaluate(() => (window as any).__screenCaptureCount)).toBe(1);
  });

  test('手机聊天区可打开并关闭联系人和群成员侧栏', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await preparePage(page);
    await page.goto('/remote');
    await page.getByRole('button', { name: '打开联系人列表' }).click();
    await expect(page.locator('.remote-sidebar')).toHaveClass(/mobile-open/);
    await page.getByRole('button', { name: '关闭列表' }).click();
    await expect(page.locator('.remote-sidebar')).not.toHaveClass(/mobile-open/);

    await page.goto('/group-chat/7');
    await page.getByRole('button', { name: '打开群成员列表' }).click();
    await expect(page.locator('.group-chat-sider')).toHaveClass(/mobile-open/);
    await page.getByRole('button', { name: '关闭成员列表' }).click();
    await expect(page.locator('.group-chat-sider')).not.toHaveClass(/mobile-open/);
  });

  test('普通成员在手机端也能查看视频和共享的完整人员列表', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await preparePage(page, 2);

    for (const route of ['/group-video/7', '/group-screen/7']) {
      await page.goto(route);
      await page.waitForLoadState('networkidle');
      await page.getByRole('button', { name: '群成员' }).click();
      await expect(page.getByText('群成员', { exact: true })).toBeVisible();
      await expect(page.locator('.n-drawer:visible').getByText('未参与').first()).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await page.keyboard.press('Escape');
    }
  });

  test('手机宽度下主要页面、弹窗和视频区域不会横向溢出', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await preparePage(page);

    for (const route of [...publicRoutes, ...authenticatedRoutes]) {
      await page.goto(route);
      await page.waitForLoadState('networkidle');
      await expectNoHorizontalOverflow(page);
      if (route === '/groups') {
        await page.getByRole('button', { name: '创建群组' }).first().click();
        await expectNoHorizontalOverflow(page);
        await page.keyboard.press('Escape');
      }
    }
  });

  test('桌面端原有页面仍保持可见且不会横向溢出', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await preparePage(page);

    for (const route of authenticatedRoutes) {
      await page.goto(route);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('#app')).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }

    await page.goto('/groups');
    await page.getByRole('button', { name: '创建群组' }).first().click();
    const createDialog = page.getByRole('dialog');
    await expect(createDialog).toBeVisible();
    await expect.poll(async () => (await createDialog.boundingBox())?.width).toBe(448);
    await page.keyboard.press('Escape');

    await page.getByText('响应式测试群组').first().click();
    const detailDialog = page.getByRole('dialog');
    await expect(detailDialog).toBeVisible();
    await expect.poll(async () => (await detailDialog.boundingBox())?.width).toBe(512);
  });
});

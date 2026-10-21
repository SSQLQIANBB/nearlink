import { expect, test, type Page } from '@playwright/test';

for (const width of [1440, 375]) {
  test(`通知声音独立设置与试听 ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await prepare(page);
    await page.addInitScript(() => {
      const originalPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        (window as unknown as { lastPlayed: HTMLMediaElement }).lastPlayed = this;
        return originalPlay.call(this);
      };
    });
    await page.goto('/profile');
    await page.getByText('通知设置', { exact: true }).click();
    await page.getByRole('switch', { name: '消息提示音', exact: true }).click();
    await expect(page.getByRole('switch', { name: '来电铃声', exact: true })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    const cards = page.locator('.sound-setting');
    await cards.nth(0).locator('.n-select').click();
    await page.getByText('清脆提示', { exact: true }).click();
    await cards.nth(1).locator('.n-select').click();
    await page.getByText('经典电话', { exact: true }).click();
    await page.getByRole('button', { name: '试听来电铃声' }).click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const audio = (window as unknown as { lastPlayed: HTMLMediaElement }).lastPlayed;
          return audio && !audio.paused && audio.duration > 0 && audio.src.includes('classic-ring');
        }),
      )
      .toBe(true);
    await page.getByRole('button', { name: '试听来电铃声' }).click();
    expect(
      await page.evaluate(
        () => (window as unknown as { lastPlayed: HTMLMediaElement }).lastPlayed.paused,
      ),
    ).toBe(true);
    await page.getByRole('button', { name: '试听消息提示音' }).click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const audio = (window as unknown as { lastPlayed: HTMLMediaElement }).lastPlayed;
          return audio.duration > 0 && audio.src.includes('happy-beep');
        }),
      )
      .toBe(true);
    await expect(cards.nth(0).getByRole('button')).toHaveText('试听');
    await page.screenshot({ path: testInfo.outputPath('notification-sounds.png'), fullPage: true });
    await page.reload();
    await page.getByText('通知设置', { exact: true }).click();
    await expect(page.getByRole('switch', { name: '消息提示音', exact: true })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await expect(cards.nth(0)).toContainText('清脆提示');
    await expect(cards.nth(1)).toContainText('经典电话');
    await page.getByRole('button', { name: '试听来电铃声' }).click();
    await page.getByText('基本信息', { exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { lastPlayed: HTMLMediaElement }).lastPlayed.paused,
        ),
      )
      .toBe(true);
  });
}

for (const width of [1440, 375]) {
  test(`群聊发言人与共用消息样式 ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await prepare(page);
    const kinds = ['text', 'image', 'voice', 'audio', 'video', 'screen'];
    const messages = [false, true].flatMap((isMine) =>
      kinds.map((kind, index) => ({
        id: (isMine ? 20 : 10) + index,
        userId: isMine ? 1 : 4,
        fromUserId: isMine ? 1 : 4,
        toUserId: isMine ? 4 : 1,
        groupId: 7,
        isRead: true,
        sender: {
          id: isMine ? 1 : 4,
          username: isMine ? 'owner' : 'monkey',
          nickname: isMine ? '本人' : '群友甲',
        },
        message: '测试消息',
        createdAt: '2026-09-20T04:00:00Z',
        messageType: index < 3 ? kind : 'call',
        media:
          kind === 'image' || kind === 'voice'
            ? {
                url: `https://chat-images.test/${kind}`,
                mimeType: kind === 'image' ? 'image/png' : 'audio/wav',
                durationSeconds: 4,
              }
            : undefined,
        call: index >= 3 ? { type: kind, status: 'completed', durationSeconds: 15 } : undefined,
      })),
    );
    await page.route(/\/api\/messages\/(private\?|group\/7\?)/, (route) =>
      route.fulfill({ json: { messages, hasMore: false } }),
    );
    await page.route('https://chat-images.test/**', (route) => route.fulfill({ status: 404 }));
    await page.goto('/group-chat/7');
    const incoming = page.locator('li.items-start:has(.group-message-row)');
    const outgoing = page.locator('li.items-end:has(.group-message-row)');
    await expect(incoming).toHaveCount(6);
    await expect(outgoing).toHaveCount(6);
    await expect(incoming.locator('.group-message-sender')).toHaveText(Array(6).fill('群友甲'));
    await expect(incoming.locator('.group-message-avatar')).toHaveCount(6);
    await expect(outgoing.locator('.group-message-sender, .group-message-avatar')).toHaveCount(0);
    await expect(incoming.locator('.call-history-message')).toHaveCount(3);
    await expect(outgoing.locator('.call-history-message')).toHaveCount(3);
    const voiceStyles = () =>
      page.locator('.chat-voice').evaluateAll((nodes) =>
        nodes.map((node) => {
          const bubble = getComputedStyle(node.closest('.message-bubble')!);
          const voice = getComputedStyle(node);
          return {
            padding: bubble.padding,
            background: bubble.backgroundColor,
            color: bubble.color,
            radius: bubble.borderRadius,
            height: voice.height,
            width: voice.width,
            direction: voice.flexDirection,
          };
        }),
      );
    const groupStyles = await voiceStyles();
    await page.goto('/remote');
    await page.getByRole('button', { name: '打开联系人列表', exact: true }).click();
    await page.locator('.contact-item').first().click();
    await expect(page.locator('.chat-voice')).toHaveCount(2);
    expect(await voiceStyles()).toEqual(groupStyles);
  });
}

for (const width of [1440, 375]) {
  for (const chat of ['private', 'group']) {
    test(`图片加载占位 ${chat} ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.routeWebSocket(/\/meeting(?:\/|\?|$)/, (socket) => socket.close());
      await page.route('**/api/remote-control/capabilities', (route) =>
        route.fulfill({
          json: {
            protocolVersion: 1,
            releasedPlatforms: [],
            webControllerReleaseEnabled: false,
            desktopControllerEnabled: false,
            desktopHostEnabled: false,
          },
        }),
      );
      await prepare(page);
      await page.route(/\/api\/messages\/(private\?|group\/7\?)/, (route) =>
        route.fulfill({
          json: {
            messages: [0, 1, 2].map((index) => ({
              id: 100 + index,
              fromUserId: index === 1 ? 1 : 4,
              toUserId: index === 1 ? 4 : 1,
              userId: index === 1 ? 1 : 4,
              groupId: 7,
              sender: { id: 4, username: 'monkey' },
              message: '',
              messageType: 'image',
              createdAt: '2026-09-20T04:00:00Z',
              isRead: true,
              media: { url: `https://chat-images.test/${index}.svg`, mimeType: 'image/svg+xml' },
            })),
            hasMore: false,
          },
        }),
      );
      let releaseImages!: () => void;
      const pendingImages = new Promise<void>((resolve) => {
        releaseImages = resolve;
      });
      await page.route('https://chat-images.test/**', async (route) => {
        await pendingImages;
        const index = Number(route.request().url().split('/').pop()!.split('.')[0]);
        if (index === 2) {
          await route.fulfill({ status: 404 });
          return;
        }
        await route.fulfill({
          contentType: 'image/svg+xml',
          body: `<svg xmlns="http://www.w3.org/2000/svg" width="${index ? 200 : 800}" height="${index ? 800 : 200}"><rect width="100%" height="100%" fill="#93c5fd"/></svg>`,
        });
      });
      await page.goto(chat === 'private' ? '/remote' : '/group-chat/7');
      if (chat === 'private') {
        await page.getByRole('button', { name: '打开联系人列表', exact: true }).click();
        await page.locator('.contact-item').first().click();
      }
      const images = page.locator('.chat-image');
      await expect(images).toHaveCount(3);
      const sizes = () =>
        images.evaluateAll((nodes) =>
          nodes.map((node) => ({ width: node.clientWidth, height: node.clientHeight })),
        );
      const before = await sizes();
      await images.first().evaluate((node) => {
        node.closest('.n-scrollbar-container')!.scrollTop = 0;
      });
      const positionBefore = await images.first().boundingBox();
      try {
        expect(before.every((size) => size.height > 80 && size.width <= 320)).toBe(true);
      } finally {
        releaseImages();
      }
      await expect(images.nth(0).locator('img')).toHaveJSProperty('naturalWidth', 800);
      await expect(images.nth(1).locator('img')).toHaveJSProperty('naturalHeight', 800);
      await expect(images.nth(2)).toContainText('图片加载失败');
      await expect(images.nth(2).getByText('图片加载中…')).toBeHidden();
      for (const index of [0, 1]) {
        const frame = (await images.nth(index).boundingBox())!;
        const photo = images.nth(index).locator('img');
        const bounds = (await photo.boundingBox())!;
        expect(bounds.height).toBeLessThanOrEqual(frame.height);
        expect(bounds.width).toBeLessThanOrEqual(frame.width);
        expect(
          Math.abs(
            index === 1 ? bounds.x + bounds.width - frame.x - frame.width : bounds.x - frame.x,
          ),
        ).toBeLessThan(1);
        await expect(photo).toHaveCSS('border-radius', '10px');
      }
      expect(await sizes()).toEqual(before);
      expect(await images.first().boundingBox()).toEqual(positionBefore);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: testInfo.outputPath('image-loaded.png') });
      const chatUrl = page.url();
      await images.first().locator('img').click();
      await expect(page.getByRole('dialog', { name: '图片预览' })).toBeVisible();
      expect(page.context().pages()).toHaveLength(1);
      expect(page.url()).toBe(chatUrl);
      await page.getByRole('button', { name: '关闭图片预览' }).click();
      await expect(page.getByRole('dialog', { name: '图片预览' })).toBeHidden();
    });
  }
}
test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

async function prepare(page: Page) {
  const settings = {
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
  const user = { id: 1, username: 'owner', nickname: 'Prometheus', status: 'online' };
  const group = { id: 7, name: '同学群', ownerId: 1, role: 'owner', memberCount: 3 };
  await page.addInitScript(() =>
    localStorage.setItem(
      '__STORAGE_PERSIST_AUTH_',
      JSON.stringify({ token: 'ui-test', refreshToken: 'ui-refresh' }),
    ),
  );
  await page.route('**/meeting/**', (route) => route.abort());
  await page.route(/\/api\/(auth|groups|messages|invitations)(?:\/|\?|$)/, (route) => {
    const url = route.request().url();
    let body: unknown = { invitations: [], messages: [], count: 0, hasMore: false, cursors: {} };
    if (url.includes('/auth/notification-settings')) {
      if (route.request().method() === 'PUT')
        Object.assign(settings, route.request().postDataJSON());
      body = { settings };
    } else if (url.includes('/auth/me')) body = { user };
    else if (url.includes('/auth/users'))
      body = {
        users: [
          user,
          { id: 4, username: 'monkey', nickname: '猴子他爹' },
          { id: 5, username: 'asd' },
        ],
      };
    else if (url.includes('/messages/private?'))
      body = {
        messages: [
          {
            id: 91,
            fromUserId: 4,
            toUserId: 1,
            message: '一起开始远程协作吧',
            messageType: 'text',
            createdAt: '2026-09-20T04:00:00Z',
            isRead: true,
          },
          {
            id: 92,
            fromUserId: 4,
            toUserId: 1,
            message: '',
            messageType: 'call',
            call: { type: 'audio', status: 'completed', durationSeconds: 15 },
            createdAt: '2026-09-20T04:01:00Z',
            isRead: true,
          },
          {
            id: 93,
            fromUserId: 1,
            toUserId: 4,
            message: '好的，稍后发起屏幕共享',
            messageType: 'text',
            createdAt: '2026-09-20T04:02:00Z',
            isRead: true,
          },
        ],
      };
    else if (url.includes('/groups/my')) body = { groups: [group] };
    else if (/\/groups\/7$/.test(url))
      body = {
        group,
        members: [
          { ...user, role: 'owner', canSpeak: true },
          { id: 2, username: '师绍卿', role: 'member', canSpeak: true },
          { id: 3, username: 'mu', role: 'member', canSpeak: false },
        ],
        myRole: 'owner',
        myCanSpeak: true,
      };
    return route.fulfill({ json: body });
  });
}

for (const width of [1440, 375]) {
  test(`设计稿布局与邀请选择 ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/login');
    await expect(page.locator('.login-card')).toBeVisible();
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('login.png') });
    await prepare(page);
    await page.goto('/remote');
    await expect(page.getByText('开启高效远程协作')).toBeVisible();
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('empty.png') });
    await page.getByRole('button', { name: '打开联系人列表', exact: true }).click();
    await expect(page.locator('.contact-item').first()).toBeVisible();
    if (width < 768) {
      await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('drawer.png') });
      await page.locator('.sidebar-backdrop').click({ position: { x: width - 5, y: 400 } });
      await expect(page.locator('.sidebar-backdrop')).toHaveCount(0);
      await page.getByRole('button', { name: '打开联系人列表', exact: true }).click();
    }
    await page.locator('.contact-item').first().click();
    await expect(page.getByText('一起开始远程协作吧')).toBeVisible();
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('chat.png') });
    const editor = page.getByRole('textbox', { name: '消息', exact: true });
    await expect(editor).toBeVisible();
    await editor.click();
    await expect(editor).toBeFocused();
    await page.getByText('一起开始远程协作吧', { exact: true }).click();
    await expect(editor).not.toBeFocused();
    if (width < 768) {
      await expect(editor).toHaveCSS('font-size', '16px');
      await expect(page.locator('body')).toHaveCSS('position', 'fixed');
      await expect(page.locator('html')).toHaveCSS('overscroll-behavior', 'none');
      await expect(page.locator('html')).toHaveCSS('touch-action', 'pan-x pan-y');
    }
    await expect(page.locator('.header-icon')).toHaveCount(0);
    await expect(page.locator('.message-time')).toHaveCount(0);
    await expect(page.getByText('通话时长 00:15')).toBeVisible();
    const image = page.getByRole('button', { name: '发送图片', exact: true });
    const send = page.getByRole('button', { name: '发送', exact: true });
    const imageBox = (await image.boundingBox())!;
    const editorBox = (await editor.boundingBox())!;
    const sendBox = (await send.boundingBox())!;
    expect(imageBox.y + imageBox.height).toBeLessThan(editorBox.y);
    expect(
      Math.abs(sendBox.y + sendBox.height / 2 - editorBox.y - editorBox.height / 2),
    ).toBeLessThan(2);
    await expect(send).toBeDisabled();
    await editor.fill('测试发送');
    await send.click();
    await expect(
      page.locator('.message-bubble').getByText('测试发送', { exact: true }),
    ).toBeVisible();
    await expect(editor).toBeEmpty();
    await page.goto('/groups');
    await expect(page.locator('.group-card')).toBeVisible();
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('groups.png') });
    await page.getByRole('button', { name: '创建群组', exact: true }).click();
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('create.png') });
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.locator('.group-card-title').click();
    await page.getByText('成员管理 (3)', { exact: true }).click();
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('members.png') });
    await page.getByRole('button', { name: '邀请成员', exact: true }).click();
    const modal = page.locator('.group-invite-modal');
    await expect(modal.getByRole('button', { name: '确认邀请' })).toBeDisabled();
    await modal.getByText('猴子他爹', { exact: true }).click();
    await modal.getByPlaceholder('搜索联系人姓名...').fill('asd');
    await expect(modal.locator('.invite-row')).toHaveCount(1);
    await expect(modal.locator('.selected-members')).toContainText('猴子他爹');
    await modal.getByText('asd', { exact: true }).click();
    await modal.getByPlaceholder('搜索联系人姓名...').clear();
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('invite.png') });
    await expect(modal.locator('.invite-row input:checked')).toHaveCount(2);
    const invitation = page.waitForRequest(
      (request) => request.url().endsWith('/api/groups/7/invite') && request.method() === 'POST',
    );
    await modal.getByRole('button', { name: '确认邀请', exact: true }).click();
    expect((await invitation).postDataJSON()).toEqual({ userIds: [4, 5] });
    await expect(modal).toHaveCount(0);
    await page.getByRole('button', { name: '邀请成员', exact: true }).click();
    await expect(modal.locator('.invite-row input:checked')).toHaveCount(0);
    await modal.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '删除群组', exact: true }).click();
    await expect(page.getByText('确认删除群组？')).toBeVisible();
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('delete.png') });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
  });
}

test('退出登录需确认，取消保留会话', async ({ page }) => {
  await prepare(page);
  await page.goto('/remote');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByText('确认退出当前账号吗？')).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page).toHaveURL(/remote/);
  await expect(page.locator('.n-dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.locator('.n-dialog').getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page).toHaveURL(/login/);
});

test('登录自动填充保持深色输入框', async ({ page }) => {
  await page.goto('/login');
  await expect(page.locator('.login-card input').first()).toBeVisible();
  const session = await page.context().newCDPSession(page);
  await session.send('DOM.enable');
  await session.send('CSS.enable');
  const { root } = await session.send('DOM.getDocument');
  const { nodeId } = await session.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: '.login-card input',
  });
  await session.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['autofill'] });
  await expect
    .poll(() =>
      page
        .locator('.login-card input')
        .first()
        .evaluate((input) => getComputedStyle(input).webkitTextFillColor),
    )
    .toBe('rgb(255, 255, 255)');
  const style = await page
    .locator('.login-card input')
    .first()
    .evaluate((input) => {
      const style = getComputedStyle(input);
      return { shadow: style.boxShadow, text: style.webkitTextFillColor };
    });
  expect(style.shadow).toContain('rgb(17, 26, 46)');
  expect(style.text).toBe('rgb(255, 255, 255)');
});

for (const width of [1440, 375]) {
  for (const chat of ['private', 'group']) {
    test(`会话工具栏布局 ${chat} ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await prepare(page);
      await page.goto(chat === 'private' ? '/remote' : '/group-chat/7');
      if (chat === 'private') {
        if (width < 768)
          await page.getByRole('button', { name: '打开联系人列表', exact: true }).click();
        await page.locator('.contact-item').first().click();
      }
      const toolbar = page.locator('.composer-toolbar');
      const image = toolbar.getByRole('button', { name: '发送图片', exact: true });
      await expect(image).toBeVisible();
      const input = page.locator('.composer-input-row');
      const inputBox = (await input.boundingBox())!;
      const toolbarBox = (await toolbar.boundingBox())!;
      expect(toolbarBox.y + toolbarBox.height).toBeLessThanOrEqual(inputBox.y + 1);
      const buttons = await toolbar.getByRole('button').all();
      const imageHeight = (await image.boundingBox())!.height;
      for (const button of buttons) {
        expect((await button.boundingBox())!.height).toBe(imageHeight);
      }
      const toggle = input.getByRole('button', { name: '切换语音输入' });
      await expect(toggle).toHaveCSS('width', '40px');
      await expect(toggle).toHaveCSS('height', '40px');
      await expect(input).toHaveCSS('padding', width === 375 ? '14px 10px' : '12px 16px');
      if (chat === 'group') {
        await expect(
          page.locator('.group-chat-sider').getByRole('button', { name: /视频通话|语音通话|屏幕共享/ }),
        ).toHaveCount(0);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: testInfo.outputPath('composer-toolbar.png') });
      await toggle.click();
      await expect(input.getByRole('button', { name: '切换文字输入' })).toHaveCSS('width', '40px');
      await expect(input.locator('.hold-to-talk')).toBeVisible();
    });
  }
}

for (const chat of ['private', 'group']) {
  test(`消息加载与空状态 ${chat}`, async ({ page }, testInfo) => {
    await prepare(page);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const endpoint = chat === 'private' ? '**/api/messages/private?*' : '**/api/messages/group/7?*';
    await page.route(endpoint, async (route) => {
      await pending;
      await route.fulfill({ json: { messages: [], hasMore: false } });
    });
    await page.goto(chat === 'private' ? '/remote' : '/group-chat/7');
    if (chat === 'private') await page.locator('.contact-item').first().click();
    await expect(page.getByRole('status', { name: '获取消息中...' })).toBeVisible();
    await expect(page.locator('.message-empty')).toHaveCount(0);
    await expect(page.locator('.loading-dots span')).toHaveCount(3);
    await expect(page.locator('.loading-dots span').first()).toHaveCSS(
      'animation-duration',
      '1.2s',
    );
    await page.screenshot({ path: testInfo.outputPath('history-loading.png') });
    release();
    await expect(page.locator('.history-loading')).toHaveCount(0);
    await expect(page.getByText('还没有消息', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('history-empty.png') });
    await page.route(endpoint, (route) =>
      route.fulfill({ status: 500, json: { message: 'test failure' } }),
    );
    if (chat === 'private') await page.locator('.contact-item').first().click();
    else await page.reload();
    await expect(page.locator('.history-error')).toBeVisible();
    await expect(page.locator('.message-empty')).toHaveCount(0);
    await page.route(endpoint, (route) =>
      route.fulfill({ json: { messages: [], hasMore: false } }),
    );
    await page.getByRole('button', { name: '重新获取', exact: true }).click();
    await expect(page.getByText('还没有消息', { exact: true })).toBeVisible();
  });
}

test('切换联系人时旧请求不结束新会话加载', async ({ page }) => {
  await prepare(page);
  const requests: Array<import('@playwright/test').Route> = [];
  await page.route('**/api/messages/private?*', (route) => {
    requests.push(route);
  });
  await page.goto('/remote');
  await page.locator('.contact-item').nth(0).click();
  await expect.poll(() => requests.length).toBe(1);
  await page.locator('.contact-item').nth(1).click();
  await expect.poll(() => requests.length).toBe(2);
  await requests[0]!.fulfill({ json: { messages: [], hasMore: false } });
  await expect(page.locator('.history-loading')).toBeVisible();
  await expect(page.locator('.message-empty')).toHaveCount(0);
  await requests[1]!.fulfill({ json: { messages: [], hasMore: false } });
  await expect(page.getByText('还没有消息', { exact: true })).toBeVisible();
});

test.describe('语音输入', () => {
  test('语音模式与按住录音展示', async ({ page }, testInfo) => {
    await prepare(page);
    await page.goto('/remote');
    await page.locator('.contact-item').first().click();
    const editor = page.getByRole('textbox', { name: '消息', exact: true });
    await editor.fill('保留草稿');
    await page.screenshot({ path: testInfo.outputPath('text-mode.png') });
    await page.getByRole('button', { name: '切换语音输入' }).click();
    await expect(editor).toBeHidden();
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeHidden();
    const hold = page.locator('.hold-to-talk');
    await expect(hold).toHaveText('按住 说话');
    await page.screenshot({ path: testInfo.outputPath('voice-mode.png') });
    const box = (await hold.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect(hold.locator('.audio-waveform')).toBeVisible();
    await expect(hold).toContainText('松开 发送');
    await expect(hold.locator('.audio-waveform__side i')).toHaveCount(6);
    await page.screenshot({ path: testInfo.outputPath('recording.png') });
    await page.mouse.move(box.x + box.width / 2, box.y - 60);
    await expect(hold).toContainText('松开取消');
    await page.mouse.up();
    await expect(hold).toHaveText('按住 说话');
    await page.getByRole('button', { name: '切换文字输入' }).click();
    await expect(editor).toHaveText('保留草稿');
  });
});

for (const width of [1440, 375]) {
  test(`群聊输入区与禁言 ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await prepare(page);
    await page.goto('/group-chat/7');
    const composer = page.locator('.group-chat-composer');
    const editor = composer.getByRole('textbox', { name: '消息', exact: true });
    await expect(editor).toBeVisible();
    await editor.fill('群聊测试消息');
    await composer.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByText('群聊测试消息', { exact: true })).toBeVisible();
    await expect(editor).toBeEmpty();
    await page.screenshot({ path: testInfo.outputPath('group-text.png') });
    await composer.getByRole('button', { name: '切换语音输入' }).click();
    await expect(editor).toBeHidden();
    await expect(composer.locator('.hold-to-talk')).toHaveText('按住 说话');
    await page.screenshot({ path: testInfo.outputPath('group-voice.png') });
    await composer.getByRole('button', { name: '切换文字输入' }).click();
    await expect(editor).toBeVisible();
    await page.route('**/api/groups/7', (route) =>
      route.fulfill({
        json: {
          group: { id: 7, name: '同学群', ownerId: 2 },
          members: [{ id: 1, username: 'owner', canSpeak: false, role: 'member' }],
          myRole: 'member',
          myCanSpeak: false,
        },
      }),
    );
    await page.reload();
    await expect(page.getByText('您已被禁言，无法发送消息')).toBeVisible();
    await expect(editor).toHaveAttribute('contenteditable', 'false');
    await expect(composer.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
    await expect(composer.getByRole('button', { name: '发送图片', exact: true })).toBeDisabled();
    await expect(composer.getByRole('button', { name: '切换语音输入' })).toBeDisabled();
  });
}

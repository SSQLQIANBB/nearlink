import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';

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
  await page.route(/^https?:\/\/[^/]+\/meeting(?:\/|\?|$)/, (route) => route.abort());
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
    await page.routeWebSocket(/\/meeting(?:\/|\?|$)/, socket => socket.close());
    await page.goto('/login');
    await expect(page.locator('.login-card')).toBeVisible();
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('login.png') });
    await prepare(page);
    await page.goto('/remote');
    await expect(page.getByText('开启高效远程协作')).toBeVisible();
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('empty.png') });
    await expect(page.locator('.contact-item').first()).toBeVisible();
    await page.locator('.contact-item').first().click();
    await expect(page.getByText('一起开始远程协作吧')).toBeVisible();
    if (width < 768) {
      await page.getByRole('button', { name: '打开联系人列表', exact: true }).click();
      await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('drawer.png') });
      await page.getByRole('button', { name: '关闭列表', exact: true }).click();
      await expect(page.locator('.sidebar-backdrop')).toHaveCount(0);
    }
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
  await page.routeWebSocket(/\/meeting(?:\/|\?|$)/, (socket) => socket.close());
  await prepare(page);
  await page.goto('/remote', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '打开用户菜单' }).click();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByText('确认退出当前账号吗？')).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page).toHaveURL(/remote/);
  await expect(page.locator('.n-dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '打开用户菜单' }).click();
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
      await page.routeWebSocket(/\/meeting(?:\/|\?|$)/, (socket) => socket.close());
      await prepare(page);
      await page.goto(chat === 'private' ? '/remote' : '/group-chat/7', {
        waitUntil: 'domcontentloaded',
      });
      if (chat === 'private') {
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
      await page.mouse.move(0, 0);
      for (const button of buttons) {
        const { width: buttonWidth, height: buttonHeight } = (await button.boundingBox())!;
        expect(buttonWidth).toBe(buttonHeight);
        await expect(button).toHaveText('');
        await expect(button).toHaveCSS('border-radius', '4px');
        await expect(button).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      }
      await image.hover();
      await expect(image).toHaveCSS('background-color', 'rgb(226, 232, 240)');
      await expect(page.locator('.n-tooltip').filter({ hasText: /^\s*发送图片\s*$/ })).toHaveCount(0);
      await page.mouse.move(0, 0);
      await expect(image).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      for (const name of ['发送图片', '视频通话', '语音通话', '屏幕共享']) {
        await expect(toolbar.getByRole('button', { name, exact: true })).toHaveAttribute('title', name);
      }
      const toggle = input.getByRole('button', { name: '切换语音输入' });
      await expect(toggle).toHaveCSS('width', '40px');
      await expect(toggle).toHaveCSS('height', '40px');
      await expect(input).toHaveCSS('padding', width === 375 ? '14px 10px' : '12px 16px');
      if (chat === 'group') {
        for (const name of ['视频通话', '语音通话', '屏幕共享']) {
          const button = toolbar.getByRole('button', { name, exact: true });
          await expect(button).toBeVisible();
          await expect(button).toBeEnabled();
        }
        await expect(page.locator('.group-chat-header').getByRole('button', { name: '通话与屏幕共享' })).toHaveCount(0);
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

test('删除会议记录使用应用确认弹窗，取消保留记录', async ({ page }) => {
  await page.routeWebSocket(/\/meeting(?:\/|\?|$)/, (socket) => socket.close());
  await prepare(page);
  let deleteRequests = 0;
  let nativeDialogs = 0;
  page.on('dialog', async (dialog) => {
    nativeDialogs++;
    await dialog.dismiss();
  });
  const meeting = {
    sessionId: 'test-meeting', title: '待删除的会议', durationSeconds: 5,
    source: 'offline', status: 'ended', summaryStatus: 'idle', audioStatus: 'missing',
    createdAt: '2026-11-18T00:00:00Z', transcript: '', transcriptJson: [], keyPoints: [],
  };
  await page.route(/\/api\/meetings(?:\/|\?|$)/, (route) => {
    if (route.request().method() === 'DELETE') {
      expect(new URL(route.request().url()).pathname).toBe('/api/meetings/test-meeting');
      deleteRequests++;
      return route.fulfill({ json: { ok: true } });
    }
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/test-meeting')) return route.fulfill({ json: { meeting } });
    return route.fulfill({ json: { items: deleteRequests ? [] : [meeting], total: deleteRequests ? 0 : 1, page: 1 } });
  });
  await page.goto('/meetings', { waitUntil: 'domcontentloaded' });

  const remove = page.getByRole('button', { name: '删除', exact: true });
  const confirmation = page.getByRole('dialog').filter({ hasText: '删除会议记录？' });
  await remove.click();
  await expect(confirmation).toContainText('删除后不可恢复。');
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(page.getByRole('button', { name: /待删除的会议/ })).toBeVisible();
  expect(deleteRequests).toBe(0);

  await remove.click();
  await confirmation.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page.getByText('暂无会议记录', { exact: true })).toBeVisible();
  expect(deleteRequests).toBe(1);
  expect(nativeDialogs).toBe(0);
});

test('会议推送按条更新、重连补查、结束定位和批量删除', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 630 });
  await prepare(page);
  const sockets: WebSocketRoute[] = [];
  let authenticated = 0;
  const send = (socket: WebSocketRoute, event: string, data: unknown) => socket.send(`42${JSON.stringify([event, data])}`);
  await page.routeWebSocket(/\/meeting(?:\/|\?|$)/, socket => {
    sockets.push(socket);
    socket.onMessage(data => {
      if (data === '40') socket.send('40{"sid":"meeting"}');
      if (typeof data === 'string' && data.startsWith('42["authenticate"')) {
        authenticated++;
        send(socket, 'authenticated', { id: 1 });
      }
    });
    socket.send('0{"sid":"engine","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}');
  });
  const first = '10000000-0000-4000-8000-000000000031';
  const second = '10000000-0000-4000-8000-000000000032';
  let hasPausedDraft = false;
  await page.routeWebSocket(/\/meeting-minutes\//, socket => {
    socket.onMessage(data => {
      if (typeof data !== 'string') return;
      if (data.startsWith('40')) socket.send('40{"sid":"recording"}');
      const request = /^42(\d+)\["(minutes_attach|minutes_pause|minutes_end)"/.exec(data);
      if (!request) return;
      if (request[2] === 'minutes_end') hasPausedDraft = false;
      socket.send(`43${request[1]}${JSON.stringify([{ ok: true, sessionId: second }])}`);
    });
    socket.send('0{"sid":"recording","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}');
  });
  const base = {
    source: 'offline', status: 'ended', audioStatus: 'missing', durationSeconds: 5, hasSummary: false,
    createdAt: '2026-11-18T00:00:00Z', transcript: '', transcriptJson: [], summary: '', keyPoints: [],
    summaryStatus: 'idle', summaryError: null as string | null, generationStage: null, regeneratingTranscript: false,
  };
  let target = { ...base, sessionId: second, title: '录音目标', summaryStatus: 'generating', generationStage: 'transcript' };
  let items = [{ ...base, sessionId: first, title: '同页另一条会议' }, target];
  const listRequests: URL[] = [];
  const detailRequests: string[] = [];
  const deletes: string[][] = [];
  function updateTarget(patch: Partial<typeof target>) {
    target = { ...target, ...patch };
    items[1] = target;
    send(sockets.at(-1)!, 'meeting_updated', { sessionId: second, item: target, detailChanged: true });
  }
  await page.route(/\/api\/meetings(?:\/|\?|$)/, route => {
    const url = new URL(route.request().url());
    if (url.pathname === `/api/meetings/${second}/transcript`) {
      updateTarget({ summaryStatus: 'generating', generationStage: 'transcript', regeneratingTranscript: true, summaryError: null });
      return route.fulfill({ status: 202, json: { ok: true } });
    }
    if (url.pathname.endsWith('/active')) {
      return route.fulfill({ json: hasPausedDraft
        ? { active: true, sessionId: second, source: 'offline', status: 'paused', resumable: true }
        : { active: false } });
    }
    if (url.pathname.endsWith('/batch-delete')) {
      deletes.push(route.request().postDataJSON().sessionIds);
      items = [];
      return route.fulfill({ status: 202, json: { deletedCount: 2 } });
    }
    const match = items.find(item => url.pathname.endsWith(`/${item.sessionId}`));
    if (match) {
      detailRequests.push(match.sessionId);
      return route.fulfill({ json: { meeting: match.sessionId === second ? target : match } });
    }
    listRequests.push(url);
    return route.fulfill({ json: { items, total: items.length ? 22 : 0, page: items.length ? 2 : 1, pageSize: 20 } });
  });
  await page.goto(`/meetings?sessionId=${second}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: '录音目标' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('正在根据完整录音生成转写')).toBeVisible();
  await expect.poll(() => authenticated).toBe(1);
  const detailPanel = page.getByRole('region', { name: '会议详情' });
  const hasVerticalOverflow = () => detailPanel.evaluate(el => el.scrollHeight > el.clientHeight);
  await expect.poll(hasVerticalOverflow).toBe(false);
  await expect(page.getByRole('button', { name: /录音目标.*转写生成中/ })).toBeVisible();
  await page.getByRole('button', { name: 'AI 纪要', exact: true }).click();
  await expect(page.getByText('转写完成后将自动生成 AI 纪要')).toBeVisible();
  await expect(page.getByText('正在生成 AI 纪要', { exact: true })).toHaveCount(0);
  await expect.poll(hasVerticalOverflow).toBe(false);
  await page.setViewportSize({ width: 1280, height: 350 });
  await expect.poll(hasVerticalOverflow).toBe(true);
  await page.setViewportSize({ width: 1280, height: 630 });
  await page.getByRole('button', { name: '转写文本', exact: true }).click();
  expect(listRequests.some(url => url.searchParams.get('sessionId') === second)).toBe(true);
  const beforePush = listRequests.length;
  const socket = sockets[0];
  send(socket, 'meeting_updated', { sessionId: first, item: { ...items[0], title: '推送更新了这一条' }, detailChanged: true });
  await expect(page.getByRole('button', { name: /推送更新了这一条/ })).toBeVisible();
  expect(detailRequests).not.toContain(first);
  target = { ...target, transcript: '已完成的转写', generationStage: 'summary' };
  items[1] = target;
  send(socket, 'meeting_updated', { sessionId: second, item: target, detailChanged: true });
  await expect(page.getByText('已完成的转写')).toBeVisible();
  await page.getByRole('button', { name: 'AI 纪要', exact: true }).click();
  await expect(page.getByText('正在生成 AI 纪要')).toBeVisible();
  await expect.poll(hasVerticalOverflow).toBe(false);
  expect(listRequests.length).toBe(beforePush);

  target = { ...target, summaryStatus: 'ready', generationStage: null, hasSummary: true, summary: '断线期间完成的纪要' };
  items[1] = target;
  await socket.close({ code: 1011 });
  await expect.poll(() => authenticated).toBe(2);
  await expect(page.getByText('断线期间完成的纪要')).toBeVisible();
  expect(listRequests.length).toBe(beforePush + 1);

  updateTarget({ audioStatus: 'ready', summaryStatus: 'failed', summaryError: 'timeout' });
  await expect(page.getByRole('button', { name: /录音目标.*已保留上次纪要/ })).toBeVisible();
  await page.getByRole('button', { name: '转写文本', exact: true }).click();
  await page.getByRole('button', { name: '重新生成转写' }).click();
  await expect(page.getByText('正在根据完整录音生成转写')).toBeVisible();
  await expect(page.getByRole('button', { name: /录音目标.*转写生成中/ })).toBeVisible();
  await page.getByRole('button', { name: 'AI 纪要', exact: true }).click();
  await expect(page.getByText('转写完成后将更新纪要')).toBeVisible();
  await expect(page.getByText('断线期间完成的纪要')).toBeVisible();
  await page.getByRole('button', { name: '转写文本', exact: true }).click();
  updateTarget({ summaryStatus: 'failed', summaryError: 'final_transcript_failed', generationStage: null, regeneratingTranscript: false });
  await expect(page.getByRole('button', { name: /录音目标.*完整录音转写失败/ })).toBeVisible();
  await expect(page.getByText('已完成的转写')).toBeVisible();
  await page.getByRole('button', { name: '重新生成转写' }).click();
  await expect(page.getByText('正在根据完整录音生成转写')).toBeVisible();
  await expect(page.getByRole('button', { name: /录音目标.*转写生成中/ })).toBeVisible();
  updateTarget({ summaryStatus: 'generating', generationStage: 'summary', regeneratingTranscript: false, transcript: '重新生成的转写' });
  await expect(page.getByText('重新生成的转写')).toBeVisible();
  await page.getByRole('button', { name: 'AI 纪要', exact: true }).click();
  await expect(page.getByText('正在生成 AI 纪要')).toBeVisible();
  updateTarget({ summaryStatus: 'ready', generationStage: null, summary: '重新生成的纪要' });
  await expect(page.getByRole('button', { name: /录音目标.*已生成纪要/ })).toBeVisible();
  await expect(page.getByText('重新生成的纪要')).toBeVisible();

  await expect(page.getByRole('button', { name: '返回', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '新建录音' }).click();
  await expect(page).toHaveURL(/\/meetings\?/);
  await expect(page.getByRole('heading', { name: '会议列表' })).toBeVisible();
  const recording = page.getByRole('region', { name: '会议录音' });
  await expect(recording.getByRole('button', { name: '开始录音' })).toBeEnabled();
  await expect(recording.getByText('实时转写', { exact: true })).toBeVisible();
  await expect(recording.getByText('独立线下录音', { exact: false })).toHaveCount(0);
  await expect(recording.getByRole('heading', { name: '会议录音' })).toHaveCount(0);
  await page.getByRole('button', { name: /录音目标/ }).click();
  await expect(recording).toHaveCount(0);

  hasPausedDraft = true;
  await page.getByRole('button', { name: '新建录音' }).click();
  await recording.getByRole('button', { name: '恢复上次录音' }).click();
  await expect(recording.getByRole('button', { name: '继续', exact: true })).toBeVisible();
  const liveMeeting = page.getByRole('button', { name: /录音目标/ });
  await expect(liveMeeting).toHaveAttribute('aria-current', 'true');
  const expandRecording = page.getByRole('button', { name: '展开录音页' });
  await expect(expandRecording).toBeHidden();
  await page.getByRole('button', { name: /同页另一条会议/ }).click();
  await expect(expandRecording).toBeVisible();
  await expandRecording.click();
  await recording.getByRole('button', { name: '结束', exact: true }).click();
  await expect(recording).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '录音目标' })).toBeVisible();
  await expect(liveMeeting).toHaveAttribute('aria-current', 'true');

  const meetingList = page.getByRole('complementary', { name: '会议列表' });
  await meetingList.getByRole('button', { name: '批量删除' }).click();
  await meetingList.getByRole('checkbox', { name: '全选', exact: true }).click();
  await expect(meetingList.getByText('已选 2', { exact: true })).toBeVisible();
  await meetingList.getByRole('button', { name: '删除', exact: true }).click();
  const confirm = page.getByRole('dialog').filter({ hasText: '批量删除会议记录？' });
  await expect(confirm).toContainText('选中的 2 条');
  expect(deletes).toHaveLength(0);
  await confirm.getByRole('button', { name: '确认删除' }).click();
  await expect(page.getByText('暂无会议记录', { exact: true })).toBeVisible();
  expect(deletes).toEqual([[first, second]]);
});

test('会议音频吸顶，转写和纪要共用详情滚动', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 720 });
  await page.routeWebSocket(/\/meeting(?:\/|\?|$)/, (socket) => socket.close());
  await prepare(page);
  const sampleRate = 8000;
  const wav = Buffer.alloc(44 + 36 * sampleRate * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  const audioUrl = `data:audio/wav;base64,${wav.toString('base64')}`;
  const meeting = {
    sessionId: 'timed', title: '词级时间戳会议', durationSeconds: 36,
    source: 'offline', status: 'ended', summaryStatus: 'idle', audioStatus: 'ready',
    createdAt: '2026-11-18T00:00:00Z', audioUrl, transcript: '', keyPoints: [],
    summary: '会议纪要内容\n\n'.repeat(40),
  };
  const legacy = { ...meeting, sessionId: 'legacy', title: '历史会议' };
  const segments = [
    {
      segmentId: 0, text: '你好，今天吃饭了吗', startMs: 0, endMs: 5000, speakerId: null,
      words: [
        { text: '你好', startMs: 0, endMs: 800 },
        { text: '今天', startMs: 1300, endMs: 2900 },
        { text: '吃饭', startMs: 3000, endMs: 3900 },
        { text: '了吗', startMs: 4100, endMs: 4800 },
      ],
    },
    ...Array.from({ length: 24 }, (_, index) => ({
      segmentId: index + 1, text: `后续转写 ${index + 1}`, startMs: (index + 6) * 1000,
      endMs: (index + 7) * 1000, speakerId: null,
    })),
  ];
  await page.route(/\/api\/meetings(?:\/|\?|$)/, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/timed')) return route.fulfill({ json: { meeting: { ...meeting, transcriptJson: segments } } });
    if (path.endsWith('/legacy')) return route.fulfill({ json: {
      meeting: { ...legacy, transcriptJson: [{ segmentId: 0, text: '历史片段', startMs: 9000, endMs: 11000, speakerId: null }] },
    } });
    return route.fulfill({ json: { items: [meeting, legacy], total: 2, page: 1 } });
  });
  await page.goto('/meetings', { waitUntil: 'domcontentloaded' });
  const audio = page.locator('.audio-sticky audio');
  const player = page.locator('.audio-sticky');
  const panel = page.getByRole('region', { name: '会议详情' });
  const transcript = page.locator('.detail-transcript');
  const detailScroll = () => panel.evaluate((el) => el.scrollTop);
  const stickyOffset = () => panel.evaluate((el) => Math.round(
    el.querySelector('.audio-sticky')!.getBoundingClientRect().top - el.getBoundingClientRect().top - el.clientTop,
  ));
  const getPosition = () => audio.evaluate((el: HTMLAudioElement) => el.currentTime);
  const seek = (time: number) => audio.evaluate((el: HTMLAudioElement, seconds) => { el.currentTime = seconds; }, time);
  await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.duration)).toBe(36);
  await expect(transcript.locator('.detail-transcript-text').first()).toHaveText('你好，今天吃饭了吗');
  await expect(transcript).toHaveCSS('overflow-y', 'visible');
  await expect(player).toHaveCSS('position', 'sticky');

  const word = transcript.getByRole('button', { name: '吃饭', exact: true });
  await seek(3.2);
  await expect(word).toHaveAttribute('aria-current', 'true');
  await seek(5.5);
  await expect(transcript.locator('[aria-current="true"]')).toHaveCount(0);
  await word.click();
  await expect.poll(getPosition).toBe(3);
  await expect(word).toHaveAttribute('aria-current', 'true');
  await seek(2.95);
  await expect(transcript.locator('[aria-current="true"]')).toHaveCount(0);
  await audio.evaluate((el: HTMLAudioElement) => el.play());
  await expect(word).toHaveAttribute('aria-current', 'true');
  await audio.evaluate((el: HTMLAudioElement) => el.pause());

  await seek(29.5);
  await expect(transcript.getByRole('button', { name: '后续转写 24', exact: true })).toHaveAttribute('aria-current', 'true');
  await expect.poll(detailScroll).toBeGreaterThan(0);
  await expect.poll(stickyOffset).toBe(0);
  const scrollAtEnd = await detailScroll();
  await seek(3);
  await expect(word).toHaveAttribute('aria-current', 'true');
  await expect.poll(detailScroll).toBeLessThan(scrollAtEnd);
  expect((await word.boundingBox())!.y).toBeGreaterThanOrEqual(
    (await player.boundingBox())!.y + (await player.boundingBox())!.height,
  );

  await page.getByRole('button', { name: 'AI 纪要', exact: true }).click();
  await panel.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect.poll(stickyOffset).toBe(0);

  await page.getByRole('button', { name: /历史会议/ }).click();
  const legacyLine = transcript.getByRole('button', { name: '历史片段', exact: true });
  await expect(legacyLine).not.toHaveAttribute('aria-current', 'true');
  await expect.poll(detailScroll).toBe(0);
  await legacyLine.click();
  await expect.poll(getPosition).toBe(9);
  await expect(legacyLine).toHaveAttribute('aria-current', 'true');
});

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
  await page.routeWebSocket(/\/meeting(?:\/|\?|$)/, socket => socket.close());
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

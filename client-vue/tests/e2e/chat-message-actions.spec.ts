import { expect, test, type Page } from '@playwright/test';

test.use({ channel: 'chrome' });
test.setTimeout(90000);
for (const width of [1440, 375]) {
  for (const kind of ['private', 'group']) {
    test(`消息菜单、引用、多选和转发 ${kind} ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      page.on('pageerror', (error) => console.error('PAGE ERROR:', error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') console.error('BROWSER:', message.text());
      });
      await prepare(page);
      await page.route(/\/api\/messages\/group\/7\?/, (route) =>
        route.fulfill({
          json: {
            messages: [
              {
                id: 91,
                groupId: 7,
                userId: 4,
                message: '一起开始远程协作吧',
                messageType: 'text',
                sender: { id: 4, username: '小李' },
                createdAt: '2026-10-16T04:00:00Z',
              },
              {
                id: 93,
                groupId: 7,
                userId: 1,
                message: '好的，稍后发起屏幕共享',
                quote: { id: 91, kind: 'group', senderName: '小李', message: '一起开始远程协作吧' },
                messageType: 'text',
                sender: { id: 1, username: '我' },
                createdAt: '2026-10-16T04:01:00Z',
              },
              {
                id: 94,
                groupId: 7,
                userId: 4,
                message: '',
                messageType: 'call',
                call: { type: 'audio', status: 'completed', durationSeconds: 15 },
                sender: { id: 4, username: '小李' },
                createdAt: '2026-10-16T04:02:00Z',
              },
            ],
            hasMore: false,
          },
        }),
      );
      await page.goto(kind === 'group' ? '/group-chat/7' : '/remote', {
        waitUntil: 'domcontentloaded',
      });
      if (kind === 'private') {
        await page.getByRole('button', { name: '打开联系人列表', exact: true }).click();
        await page.locator('.contact-item').first().click();
      }
      const bubble = page.locator('.message-action-target').first();
      await expect(bubble).toContainText('一起开始远程协作吧', { timeout: 60000 });
      if (width === 375) {
        await bubble.dispatchEvent('pointerdown', {
          pointerType: 'touch',
          clientX: 150,
          clientY: 200,
        });
        await expect(page.getByText('引用', { exact: true })).toBeVisible();
        await bubble.dispatchEvent('pointerup', { pointerType: 'touch' });
      } else await bubble.click({ button: 'right' });
      for (const action of ['复制', '转发', '引用', '多选', '删除'])
        await expect(page.getByText(action, { exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('menu.png') });
      await page.getByText('引用', { exact: true }).click();
      await expect(page.locator('.quote-draft')).toContainText('一起开始远程协作吧');
      await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath('quote.png') });
      await page.getByRole('button', { name: '取消引用', exact: true }).click();
      await bubble.click({ button: 'right' });
      await page.getByText('多选', { exact: true }).click();
      await expect(page.getByRole('toolbar', { name: '多选消息操作' })).toContainText('已选 1 条');
      const selectedRows = page.locator('li[data-selecting="true"]');
      await expect(selectedRows.locator('.incoming-avatar, .group-message-avatar')).toHaveCount(0);
      if (kind === 'group') {
        await expect(selectedRows.first().locator('.group-message-sender')).toHaveText('小李');
      }
      const checkboxBounds = await selectedRows.first().locator('.message-selection').boundingBox();
      const bubbleBounds = await bubble.boundingBox();
      expect(checkboxBounds!.x + checkboxBounds!.width).toBeLessThan(bubbleBounds!.x);
      await page.screenshot({ path: testInfo.outputPath('selection.png') });
      const lastCheckbox = selectedRows.last().locator('.message-selection');
      await page.locator('.message-action-target').last().click();
      await expect(page.getByRole('toolbar')).toContainText('已选 2 条');
      await expect(lastCheckbox).toBeChecked();
      await page.locator('.message-action-target').last().click();
      await expect(lastCheckbox).not.toBeChecked();
      await lastCheckbox.check();
      await expect(page.getByRole('toolbar')).toContainText('已选 2 条');
      await lastCheckbox.uncheck();
      await expect(page.getByRole('toolbar')).toContainText('已选 1 条');
      await lastCheckbox.focus();
      await lastCheckbox.press('Space');
      await expect(lastCheckbox).toBeChecked();
      await expect(page.getByRole('toolbar')).toContainText('已选 2 条');
      await lastCheckbox.press('Space');
      await expect(lastCheckbox).not.toBeChecked();
      await expect(page.getByRole('toolbar')).toContainText('已选 1 条');
      await page.locator('.message-action-target').last().click();
      await expect(page.getByRole('toolbar')).toContainText('已选 2 条');
      await expect(lastCheckbox).toBeChecked();
      await page.getByRole('button', { name: '删除', exact: true }).click();
      await expect(page.getByText('所选消息将从你的所有设备上删除')).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('delete.png') });
      await page.getByRole('button', { name: '取消', exact: true }).last().click();
      await page.getByRole('button', { name: '逐条转发' }).click();
      await expect(page.getByRole('dialog', { name: '转发消息' })).toBeVisible();
      await page.locator('.recipient input').first().check();
      await expect(page.locator('.recipient-tags')).not.toBeEmpty();
      const noteInput = page.getByPlaceholder('留言', { exact: true });
      await noteInput.click();
      await expect(noteInput).toBeFocused();
      await noteInput.pressSequentially('Please review 123');
      await expect(noteInput).toHaveValue('Please review 123');
      await noteInput.fill('请查看这条消息');
      await expect(noteInput).toHaveValue('请查看这条消息');
      await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
      await page.screenshot({ path: testInfo.outputPath('forward.png') });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.getByRole('button', { name: '取消', exact: true }).last().click();
      await page.getByRole('button', { name: '退出多选' }).click();
      await expect(page.locator('.incoming-avatar, .group-message-avatar').first()).toBeVisible();
      await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeVisible();
    });
  }
}

async function prepare(page: Page) {
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

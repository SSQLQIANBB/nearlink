import { expect, test, type Page } from '@playwright/test';

type GroupRole = 'owner' | 'admin' | 'member';

async function prepareGroups(page: Page, options: { role: GroupRole; deleteStatus?: number }) {
  let deleted = false;
  let deleteRequests = 0;

  await page.route(/\/meeting(?:\/|\?|$)/, (route) => route.abort());
  await page.route(/\/api\/auth\/me$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: { id: 1, username: 'owner', nickname: '测试用户', status: 'online' },
      }),
    }),
  );

  await page.addInitScript(() => {
    localStorage.setItem('token', 'group-delete-token');
    localStorage.setItem(
      '__STORAGE_PERSIST_AUTH_',
      JSON.stringify({ token: 'group-delete-token', refreshToken: 'group-delete-refresh-token' }),
    );
    localStorage.setItem(
      'user',
      JSON.stringify({
        id: 1,
        username: 'owner',
        nickname: '测试用户',
      }),
    );
  });

  await page.route(/\/api\/groups(?:\/|\?|$)/, async (route) => {
    const url = route.request().url();
    const method = route.request().method();

    if (method === 'DELETE' && /\/api\/groups\/7$/.test(url)) {
      deleteRequests += 1;
      const status = options.deleteStatus ?? 200;
      if (status >= 400) {
        await route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify({ error: '删除群组失败：数据库不可用' }),
        });
        return;
      }
      deleted = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ message: '群组已删除' }),
      });
      return;
    }

    if (url.includes('/api/groups/my')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          groups: deleted
            ? []
            : [
                {
                  id: 7,
                  name: '待删除测试群组',
                  ownerId: 1,
                  role: options.role,
                  memberCount: 2,
                },
              ],
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        group: { id: 7, name: '待删除测试群组', ownerId: 1 },
        members: [{ id: 1, username: 'owner', role: options.role, canSpeak: true }],
        myRole: options.role,
        myCanSpeak: true,
      }),
    });
  });

  return {
    getDeleteRequests: () => deleteRequests,
  };
}

async function openGroupDetail(page: Page) {
  await page.goto('/groups');
  await page.getByText('待删除测试群组').first().click();
  await expect(page.getByText('群组ID：')).toBeVisible();
}

test.describe('群组删除', () => {
  test('只有群主可以看到删除按钮', async ({ page }) => {
    await prepareGroups(page, { role: 'owner' });
    await openGroupDetail(page);
    await expect(page.getByRole('button', { name: '删除群组' })).toBeVisible();
  });

  for (const role of ['admin', 'member'] as const) {
    test(`${role} 看不到删除按钮`, async ({ page }) => {
      await prepareGroups(page, { role });
      await openGroupDetail(page);
      await expect(page.getByRole('button', { name: '删除群组' })).toHaveCount(0);
    });
  }

  test('取消二次确认不会发送删除请求', async ({ page }) => {
    const state = await prepareGroups(page, { role: 'owner' });
    await openGroupDetail(page);

    await page.getByRole('button', { name: '删除群组' }).click();
    await expect(page.getByText(/删除群组后，相关的群消息历史、成员关系和邀请记录/)).toBeVisible();
    await page.getByRole('button', { name: '取消' }).click();

    expect(state.getDeleteRequests()).toBe(0);
    await expect(page.getByText('待删除测试群组').first()).toBeVisible();
  });

  test('删除成功后返回群组列表且群组消失', async ({ page }) => {
    await prepareGroups(page, { role: 'owner' });
    await openGroupDetail(page);

    await page.getByRole('button', { name: '删除群组' }).click();
    await page.getByRole('button', { name: '确认删除' }).click();

    await expect(page.getByText('暂无群组')).toBeVisible();
    await expect(page.getByText('待删除测试群组')).toHaveCount(0);
    await expect(page).toHaveURL(/\/groups$/);
  });

  test('删除失败时保留群组和当前详情并展示错误', async ({ page }) => {
    await prepareGroups(page, { role: 'owner', deleteStatus: 500 });
    await openGroupDetail(page);

    await page.getByRole('button', { name: '删除群组' }).click();
    await page.getByRole('button', { name: '确认删除' }).click();

    await expect(page.getByText(/删除群组失败：数据库不可用/)).toBeVisible();
    await expect(page.getByText('群组ID：')).toBeVisible();
    await expect(page).toHaveURL(/\/groups$/);
  });
});

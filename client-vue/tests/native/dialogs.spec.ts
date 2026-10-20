import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';

// Opt-in isolated debug build: never reuse the user's installed app or account data.
test('Windows 独立窗口：更新、表单校验、删除确认与主窗口刷新清理', async ({}, testInfo) => {
  test.skip(
    process.platform !== 'win32' || !process.env.NEARLINK_DIALOG_TEST_EXECUTABLE,
    '需要 dialogtest 标识的隔离构建及 CDP 9228',
  );
  test.setTimeout(120000);
  const app = spawn(process.env.NEARLINK_DIALOG_TEST_EXECUTABLE!, [], {
    windowsHide: true,
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9228' },
  });
  let browser: Browser | undefined;
  const errors: string[] = [];
  try {
    await expect
      .poll(
        async () => {
          try {
            return (await fetch('http://127.0.0.1:9228/json/version')).ok;
          } catch {
            return false;
          }
        },
        { timeout: 30000 },
      )
      .toBe(true);
    browser = await chromium.connectOverCDP('http://127.0.0.1:9228');
    const context = browser.contexts()[0]!;
    context.setDefaultTimeout(15000);
    const groups: any[] = [];
    const user = {
      id: 1,
      username: 'tester',
      nickname: '窗口验证用户',
      email: 'test@example.test',
    };
    let creates = 0;
    await context.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      const method = route.request().method();
      let result: unknown = {
        messages: [],
        invitations: [],
        count: 0,
        hasMore: false,
        cursors: {},
      };
      if (url.pathname.endsWith('/desktop/release')) {
        // Keep the update fixture newer than the installed prerelease under test.
        const version = '99.0.0-alpha.1';
        result = {
          release: {
            version,
            assets: Object.fromEntries(
              [
                ['windows-x64', 'x64-setup.exe'],
                ['macos-arm64', 'aarch64.dmg'],
                ['macos-x64', 'x64.dmg'],
              ].map(([platform, suffix]) => [
                platform,
                {
                  size: 50_000_000,
                  url: `https://github.com/SSQLQIANBB/nearlink/releases/download/desktop-v${version}/NearLink_${version}_${suffix}`,
                },
              ]),
            ),
          },
        };
      } else if (url.pathname.endsWith('/auth/login'))
        result = { user, accessToken: 'dialog-test', refreshToken: 'dialog-test' };
      else if (url.pathname.endsWith('/auth/me')) result = { user };
      else if (url.pathname.endsWith('/auth/email')) result = { email: user.email };
      else if (url.pathname.endsWith('/auth/users'))
        result = { users: [{ id: 2, username: '联系人' }] };
      else if (url.pathname.endsWith('/notification-settings')) result = { settings: {} };
      else if (url.pathname.endsWith('/groups/my')) result = { groups };
      else if (url.pathname === '/api/groups' && method === 'POST') {
        creates++;
        const group = {
          id: 7,
          ...route.request().postDataJSON(),
          ownerId: 1,
          role: 'owner',
          memberCount: 1,
        };
        groups.push(group);
        result = { group, message: '创建成功' };
      } else if (url.pathname === '/api/groups/7')
        result = {
          group: groups[0],
          members: [{ ...user, role: 'owner', canSpeak: true }],
          myRole: 'owner',
          myCanSpeak: true,
        };
      await route.fulfill({ json: result });
    });
    await context.route('**/meeting/**', (route) => route.abort());
    const track = (page: Page) => {
      page.on('pageerror', (error) => errors.push(error.message));
    };
    context.pages().forEach(track);
    context.on('page', track);
    const main = context.pages().find((page) => !page.url().includes('dialog='))!;
    await main.waitForURL((url) => url.protocol !== 'about:');
    await main.waitForLoadState('domcontentloaded');
    expect(
      await main.evaluate(() =>
        (window as any).__TAURI_INTERNALS__.invoke('plugin:app|identifier'),
      ),
    ).toBe('top.sycsq.nearlink.dialogtest');
    await main.evaluate(() => {
      localStorage.clear();
    });
    await main.reload();
    await main.evaluate(() =>
      (window as any).__TAURI_INTERNALS__.invoke('plugin:window|show', { label: 'main' }),
    );
    await expect(
      main.getByRole('button', { name: /检查更新|发现新版本/, exact: true }),
    ).toBeVisible();
    const openUpdate = context.waitForEvent('page');
    await main
      .getByRole('button', { name: /检查更新|发现新版本/, exact: true })
      .dispatchEvent('click');
    const update = await openUpdate;
    await expect(update.getByText('桌面端更新', { exact: true })).toBeVisible();
    await expect(update.getByRole('button', { name: '下载更新安装包' })).toBeEnabled();
    await expect(update.locator('.n-modal-mask')).toHaveCount(0);
    await main
      .getByRole('button', { name: /检查更新|发现新版本/, exact: true })
      .dispatchEvent('click');
    expect(context.pages().filter((page) => page.url().includes('dialog='))).toHaveLength(1);
    await update.screenshot({ path: testInfo.outputPath('native-update.png') });
    // Native close event traverses child -> owning window -> destroy.
    await main.evaluate(() =>
      (window as any).__TAURI_INTERNALS__.invoke('plugin:window|close', {
        label: 'dialog-main-release',
      }),
    );
    await expect.poll(() => update.isClosed()).toBe(true);
    await main.getByPlaceholder('请输入用户名或邮箱').fill('tester');
    await main.getByPlaceholder('请输入登录密码').fill('Password123');
    await main.getByRole('button', { name: '登录', exact: true }).dispatchEvent('click');
    await expect(main.getByRole('button', { name: '个人中心', exact: true })).toBeVisible();
    await expect(
      main.locator('.sidebar-download').getByRole('button', { name: '检查更新' }),
    ).toBeVisible();
    await main.screenshot({
      path: testInfo.outputPath('native-sidebar.png'),
      animations: 'disabled',
    });
    await main.getByText('我的群组', { exact: true }).dispatchEvent('click');
    await main.getByRole('button', { name: '管理', exact: true }).dispatchEvent('click');
    await expect(main.getByRole('heading', { name: '群组管理' })).toBeVisible();
    const createPage = context.waitForEvent('page');
    await main
      .getByRole('button', { name: '创建群组', exact: true })
      .first()
      .dispatchEvent('click');
    const create = await createPage;
    await create.getByRole('button', { name: '立即创建' }).dispatchEvent('click');
    await expect(create.getByText('群组名称长度在2-50个字符')).toBeVisible();
    expect(creates).toBe(0);
    await create.getByPlaceholder('请输入群组名称').fill('独立窗口测试群');
    await create.getByRole('button', { name: '立即创建' }).dispatchEvent('click');
    await expect.poll(() => create.isClosed()).toBe(true);
    await expect(main.getByText('独立窗口测试群', { exact: true })).toBeVisible();
    expect(creates).toBe(1);
    const detailPage = context.waitForEvent('page');
    await main.getByText('独立窗口测试群', { exact: true }).dispatchEvent('click');
    const detail = await detailPage;
    await detail.getByRole('button', { name: '删除群组', exact: true }).dispatchEvent('click');
    await expect(detail.getByRole('dialog')).toBeVisible();
    expect(context.pages().filter((page) => page.url().includes('dialog='))).toHaveLength(1);
    await detail.screenshot({
      path: testInfo.outputPath('native-group-delete.png'),
      animations: 'disabled',
    });
    await detail.getByRole('button', { name: '取消', exact: true }).dispatchEvent('click');
    await expect(detail.getByRole('dialog')).toBeHidden();
    await main.reload();
    await expect.poll(() => detail.isClosed()).toBe(true);
    expect(errors).toEqual([]);
  } catch (error) {
    console.log(
      '页面错误',
      errors,
      '窗口',
      browser
        ?.contexts()[0]
        ?.pages()
        .map((page) => page.url()),
    );
    throw error;
  } finally {
    if (app.pid && app.exitCode === null) {
      await new Promise<void>((resolve) => {
        app.once('exit', () => resolve());
        app.kill();
      });
    }
    await browser?.close();
  }
});

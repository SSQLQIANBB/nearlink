import { test, expect, chromium, type Browser } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Windows 客户端启动、原生 IPC、刷新与单实例', async ({}, testInfo) => {
  test.skip(process.platform !== 'win32', '仅验证 Windows 原生程序');
  const executable = fileURLToPath(new URL('../../src-tauri/target/release/nearlink-desktop.exe', import.meta.url));
  const app = spawn(executable, [], { windowsHide: true });
  let startupError: Error | undefined;
  let startupOutput = '';
  app.on('error', error => { startupError = error; });
  app.stderr?.on('data', chunk => { startupOutput += chunk.toString(); });
  let browser: Browser | undefined;
  let second: ChildProcess | undefined;
  try {
    await expect.poll(async () => {
      if (startupError) throw startupError;
      if (app.exitCode !== null) throw new Error(`客户端提前退出: ${app.exitCode}\n${startupOutput}`);
      try {
        const response = await fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(1000) });
        return response.ok;
      } catch { return false; }
    }, { timeout: 30000 }).toBe(true);
    browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    const context = browser.contexts()[0]!;
    await expect.poll(() => context.pages().length).toBeGreaterThan(0);
    const page = context.pages()[0]!;
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
    const windowState = (command: string) => page.evaluate(command => {
      const native = window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args: { label: string }) => Promise<boolean> } };
      return native.__TAURI_INTERNALS__.invoke(`plugin:window|${command}`, { label: 'main' });
    }, command);
    expect(await windowState('is_decorated')).toBe(false);
    await expect(page.getByRole('group', { name: '窗口控制' })).toBeVisible();
    await page.getByRole('button', { name: '最大化', exact: true }).click();
    await expect.poll(() => windowState('is_maximized')).toBe(true);
    await page.getByRole('button', { name: '还原', exact: true }).click();
    await expect.poll(() => windowState('is_maximized')).toBe(false);
    await page.locator('.desktop-windows-drag-region').dblclick({ position: { x: 200, y: 16 } });
    await expect.poll(() => windowState('is_maximized')).toBe(true);
    await page.getByRole('button', { name: '还原', exact: true }).click();
    await expect.poll(() => windowState('is_maximized')).toBe(false);
    // 回归主窗口只有 ICON_SMALL、任务栏回退到旧图标的问题。
    const largeIcon = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
      Add-Type 'using System; using System.Runtime.InteropServices; public static class TaskbarIconProbe { [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr hwnd, uint msg, IntPtr kind, IntPtr value); }';
      $window = (Get-Process -Id ${app.pid}).MainWindowHandle;
      [TaskbarIconProbe]::SendMessageW($window, 0x007F, [IntPtr]1, [IntPtr]::Zero).ToInt64()
    `], { encoding: 'utf8', windowsHide: true }).trim();
    expect(Number(largeIcon)).toBeGreaterThan(0);
    await expect(page.locator('.n-input').filter({ has: page.locator('input[type="password"]') })).toHaveCSS('display', /^(inline-)?flex$/);
    await expect(page.locator('.n-tabs-rail')).toHaveCSS('display', 'flex');
    expect(await page.evaluate(() => {
      const native = window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string) => Promise<boolean> } };
      return native.__TAURI_INTERNALS__.invoke('plugin:notification|is_permission_granted');
    })).toBe(true);
    expect(await page.evaluate(() => ({
      secure: window.isSecureContext,
      media: typeof navigator.mediaDevices?.getUserMedia === 'function',
      screen: typeof navigator.mediaDevices?.getDisplayMedia === 'function',
    }))).toEqual({ secure: true, media: true, screen: true });
    second = spawn(executable, [], { windowsHide: true });
    await expect.poll(() => second!.exitCode, { timeout: 10000 }).toBe(0);
    expect(app.exitCode).toBeNull();
    await page.getByRole('button', { name: '最小化', exact: true }).click();
    await expect.poll(() => windowState('is_minimized')).toBe(true);
    second = spawn(executable, [], { windowsHide: true });
    await expect.poll(() => second!.exitCode, { timeout: 10000 }).toBe(0);
    await expect.poll(() => windowState('is_minimized')).toBe(false);
    await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
    await expect.poll(() => windowState('is_visible')).toBe(false);
    expect(app.exitCode).toBeNull();
    second = spawn(executable, [], { windowsHide: true });
    await expect.poll(() => second!.exitCode, { timeout: 10000 }).toBe(0);
    await expect.poll(() => windowState('is_visible')).toBe(true);
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('windows-login.png') });
  } finally {
    await browser?.close();
    for (const child of [second, app]) {
      if (child?.pid && child.exitCode === null) {
        execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      }
    }
  }
});

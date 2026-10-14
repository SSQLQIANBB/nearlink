import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const {
  app: { security },
} = JSON.parse(readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));

test('原生 CSP 处理后登录页组件样式仍正常', async ({ page }, testInfo) => {
  // Tauri 会为 HTML 中的静态 style 添加 nonce，并将其追加至 style-src。
  // 仅使用配置中的原始 CSP 会漏掉原生包独有的 CSS-in-JS 拦截问题。
  await page.route('http://127.0.0.1:1421/', async (route) => {
    const response = await route.fetch();
    let html = await response.text();
    let csp = security.csp as string;
    if (/<style(?:\s|>)/i.test(html)) {
      html = html.replace(/<style(?=\s|>)/gi, '<style nonce="desktop-regression"');
      csp = csp.replace(/style-src([^;]*)/, "$& 'nonce-desktop-regression'");
    }
    await route.fulfill({
      response,
      body: html,
      headers: { ...response.headers(), 'content-security-policy': csp },
    });
  });
  await page.goto('/#/login');
  const password = page.locator('.n-input').filter({ has: page.locator('input[type="password"]') });
  await expect(password).toHaveCSS('display', /^(inline-)?flex$/);
  await expect(page.locator('.n-tabs-rail')).toHaveCSS('display', 'flex');
  const eye = password.locator('.n-base-icon').first();
  await expect(eye).toBeVisible();
  const size = await eye.boundingBox();
  expect(size!.width).toBeLessThan(32);
  expect(size!.height).toBeLessThan(32);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath('desktop-login.png') });
});

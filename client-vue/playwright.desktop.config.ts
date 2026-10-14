import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/desktop',
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:1421',
    channel: 'chrome',
    viewport: { width: 1200, height: 800 },
  },
  webServer: {
    command:
      'pnpm exec vite preview --config vite.desktop.config.ts --mode desktop --host 127.0.0.1 --port 1421 --strictPort',
    url: 'http://127.0.0.1:1421',
    reuseExistingServer: false,
  },
});

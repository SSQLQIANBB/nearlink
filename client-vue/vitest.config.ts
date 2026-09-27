import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';

export default defineConfig({
  // Public assets are browser URLs, not Windows filesystem module imports.
  plugins: [vue({ template: { transformAssetUrls: { includeAbsolute: false } } })],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/unit/**/*.test.ts'],
  },
});

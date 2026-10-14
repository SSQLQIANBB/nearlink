import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/integration/remoteSessionRedis.test.ts'],
    hookTimeout: 20_000,
    testTimeout: 10_000,
  },
});

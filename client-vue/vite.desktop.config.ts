import { defineConfig, loadEnv, mergeConfig } from 'vite';
import webConfig from './vite.config';
import { createPublicEnv } from './src/config/publicEnv';

export default defineConfig(async (env) => {
  const source = { ...loadEnv(env.mode, process.cwd(), 'VITE_'), ...process.env };
  const publicEnv = createPublicEnv({
    VITE_API_BASE_URL: source.VITE_API_BASE_URL,
    VITE_SOCKET_URL: source.VITE_SOCKET_URL,
  });
  if (env.command === 'build' && (!publicEnv.apiBaseUrl || !publicEnv.socketUrl)) {
    throw new Error(
      '桌面安装包必须配置 VITE_API_BASE_URL 和 VITE_SOCKET_URL，参见 .env.desktop.example',
    );
  }
  const base = typeof webConfig === 'function' ? await webConfig(env) : await webConfig;
  return mergeConfig(base, {
    clearScreen: false,
    define: { 'import.meta.env.VITE_DESKTOP': JSON.stringify('true') },
    build: { outDir: 'dist-desktop', target: 'es2021' },
    server: {
      host: '127.0.0.1',
      port: 1420,
      strictPort: true,
      watch: { ignored: ['**/src-tauri/**'] },
    },
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, loadEnv, mergeConfig, normalizePath, type Plugin } from 'vite';
import webConfig from './vite.config';

export default defineConfig(async (env) => {
  const fileEnv = loadEnv(env.mode, process.cwd(), 'DEV_HTTPS_');
  const certPath = (process.env.DEV_HTTPS_CERT ?? fileEnv.DEV_HTTPS_CERT)?.trim();
  const keyPath = (process.env.DEV_HTTPS_KEY ?? fileEnv.DEV_HTTPS_KEY)?.trim();
  if (!certPath || !keyPath) {
    throw new Error(
      '局域网 HTTPS 开发必须同时配置 DEV_HTTPS_CERT 和 DEV_HTTPS_KEY，参见 docs/ENVIRONMENT_VARIABLES.md',
    );
  }
  const base = typeof webConfig === 'function' ? await webConfig(env) : await webConfig;
  return mergeConfig(base, {
    plugins: [
      {
        name: 'https-network-urls',
        configureServer(server) {
          const printUrls = server.printUrls;
          server.printUrls = () => {
            // Vite 将证书 SAN 域名追加到 Local；局域网启动只展示网卡 IP。
            if (server.resolvedUrls) server.resolvedUrls.local = [];
            printUrls();
          };
        },
      },
    ] satisfies Plugin[],
    server: {
      host: true,
      https: {
        cert: readFileSync(resolve(certPath)),
        key: readFileSync(resolve(keyPath)),
      },
      fs: {
        deny: [
          // Vite 7 does not export its defaults; retain its sensitive-file protections.
          '.env',
          '.env.*',
          '*.{crt,pem}',
          '**/.git/**',
          '**/.certs/**',
          ...[certPath, keyPath].map((path) =>
            normalizePath(resolve(path)).replace(/[?*()[\]{}!+@]/g, '\\$&'),
          ),
        ],
      },
    },
  });
});

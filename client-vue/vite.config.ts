import { defineConfig, loadEnv, type UserConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import AutoImport from 'unplugin-auto-import/vite';
import { NaiveUiResolver } from 'unplugin-vue-components/resolvers';
import Components from 'unplugin-vue-components/vite';
import { resolve } from 'path';
import tailwindcss from 'tailwindcss';
import viteCompression from 'vite-plugin-compression';
import { createPublicEnv } from './src/config/publicEnv';

const compressibleAssets = /\.(?:js|mjs|json|css|html|svg|txt|xml|wasm)$/i;

// https://vite.dev/config/
const config = {
  plugins: [
    vue(),
    AutoImport({
      imports: [
        'vue',
        {
          'naive-ui': ['useDialog', 'useMessage', 'useNotification', 'useLoadingBar'],
        },
      ],
    }),
    Components({
      resolvers: [NaiveUiResolver()],
    }),
    viteCompression({
      algorithm: 'brotliCompress',
      ext: '.br',
      threshold: 0,
      deleteOriginFile: false,
      filter: compressibleAssets,
      compressionOptions: {
        level: 11,
      },
    }),
    viteCompression({
      algorithm: 'gzip',
      ext: '.gz',
      threshold: 0,
      deleteOriginFile: false,
      filter: compressibleAssets,
    }),
  ],
  worker: {
    format: 'es',
  },
  css: {
    postcss: {
      plugins: [tailwindcss],
    },
  },

  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },

  build: {
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;

          if (
            /[\\/]node_modules[\\/](@vue|vue|vue-router|pinia|pinia-plugin-persistedstate)[\\/]/.test(
              id,
            )
          ) {
            return 'vendor-vue';
          }

          if (/[\\/]node_modules[\\/](naive-ui|@vicons)[\\/]/.test(id)) {
            return 'vendor-ui';
          }

          if (
            /[\\/]node_modules[\\/](socket\.io-client|engine\.io-client|socket\.io-parser|@socket\.io)[\\/]/.test(
              id,
            )
          ) {
            return 'vendor-socket';
          }
        },
      },
    },
  },

  server: {
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        // rewrite: path => path.replace(/^\/sse/, '/'),
      },
      '/meeting': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        ws: true,
        // rewrite: path => path.replace(/^\/sse/, '/'),
      },
      '/uploads': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
} satisfies UserConfig;

export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, process.cwd(), 'VITE_');
  createPublicEnv({
    VITE_API_BASE_URL: process.env.VITE_API_BASE_URL ?? fileEnv.VITE_API_BASE_URL,
    VITE_SOCKET_URL: process.env.VITE_SOCKET_URL ?? fileEnv.VITE_SOCKET_URL,
  });
  return config;
});

import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const rootDir = decodeURIComponent(new URL('.', import.meta.url).pathname);

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, rootDir, '');
  const proxyTarget = env.VITE_DEV_PROXY_TARGET || 'http://localhost:2901';
  const apiKey = env.API_KEY || '';

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': decodeURIComponent(new URL('./src', import.meta.url).pathname),
      },
    },
    server: {
      port: 2101,
      proxy: {
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
          ...(apiKey
            ? {
                headers: {
                  'X-API-Key': apiKey,
                },
              }
            : {}),
        },
      },
    },
  };
});

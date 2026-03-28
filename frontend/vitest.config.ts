import { defineConfig } from 'vitest/config';

const srcDir = decodeURIComponent(new URL('./src', import.meta.url).pathname);

export default defineConfig({
  resolve: {
    alias: {
      '@': srcDir,
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
  },
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [fileURLToPath(new URL('./src/test-setup.ts', import.meta.url))],
    include: [
      'src/hooks/**/*.test.{ts,tsx}',
      'src/components/voice/**/*.test.{ts,tsx}',
      'src/i18n/**/*.test.{ts,tsx}',
    ],
  },
});

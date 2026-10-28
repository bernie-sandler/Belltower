/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, the Fastify server runs on :8080 and Vite proxies API calls to it.
const backend = process.env.TT_BACKEND ?? 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': backend,
      '/health': backend,
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    target: 'es2022',
    rolldownOptions: {
      treeshake: {
        // @tt/shared is pure (constants, zod schemas, types). Declaring that lets the bundler drop
        // the zod schemas the UI never uses, instead of shipping all of zod with the constants.
        moduleSideEffects: [{ test: /[\\/]shared[\\/]src[\\/]/, sideEffects: false }],
      },
    },
  },
});

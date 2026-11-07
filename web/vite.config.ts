/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin, type UserConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// In dev, the Fastify server runs on :8080 and Vite proxies API calls to it.
const backend = process.env.TT_BACKEND ?? 'http://127.0.0.1:8080';

const config: UserConfig = {
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
};

// ---- Browser-only demo (docs/DEMO.md) ----
// `vite --mode demo` (or VITE_DEMO=true) builds the same app with src/demo/main.tsx as its entry:
// an in-browser backend in localStorage instead of the server, a HashRouter, and the /Belltower/
// base path GitHub Pages serves it under. Nothing below applies to a normal build.

const webDir = fileURLToPath(new URL('.', import.meta.url));
const demoDir = fileURLToPath(new URL('./src/demo/', import.meta.url));
const isDemoFile = (id: string | undefined) => Boolean(id && id.replace(/\\/g, '/').startsWith(demoDir.replace(/\\/g, '/')));

function demoPlugin(): Plugin {
  return {
    name: 'belltower-demo',
    enforce: 'pre',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) =>
        html
          .replace('/src/main.tsx', '/src/demo/main.tsx')
          // The demo isn't meant to be installed as an app, and the manifest's icon paths assume "/".
          .replace(/\s*<link rel="manifest"[^>]*>/, '')
          .replace('<title>Belltower</title>', '<title>Belltower demo</title>'),
    },
    async resolveId(source, importer, options) {
      // The app's react-router imports get the demo's HashRouter-flavoured BrowserRouter.
      if (source === 'react-router' && importer && !isDemoFile(importer)) {
        return this.resolve(`${demoDir}router.tsx`, importer, { ...options, skipSelf: true });
      }
      return null;
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, webDir, 'VITE_');
  if (env.VITE_DEMO !== 'true') return config;
  return {
    ...config,
    base: env.VITE_DEMO_BASE || '/Belltower/',
    plugins: [demoPlugin(), ...(config.plugins ?? [])],
    // No server to proxy to: the demo answers /api itself.
    server: { port: 5174 },
    preview: { port: 4174 },
    // The in-browser backend (and the zod schemas it validates with) make the entry chunk bigger.
    build: { ...config.build, outDir: 'dist-demo', chunkSizeWarningLimit: 800 },
  };
});

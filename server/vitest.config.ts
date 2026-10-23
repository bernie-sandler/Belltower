import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify('test') },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Every test file gets its own temp DB; run files in parallel workers.
    pool: 'forks',
    testTimeout: 20_000,
  },
});

// End-to-end tests: the built app on a throwaway data folder, driven in Chrome at desktop and
// iPhone sizes. Uses the installed Chrome (channel 'chrome'), so no browser download is needed.
// Build first: npm run build && npm run e2e

import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 18190);
/** A test-only password for the throwaway e2e database. */
export const E2E_PASSWORD = 'e2e-only-password-not-real';

export default defineConfig({
  testDir: 'e2e',
  // Inside coverage/, which git already ignores.
  outputDir: 'coverage/e2e-results',
  fullyParallel: false, // one shared server and database
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never', outputFolder: 'coverage/e2e-report' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: 'chrome',
    trace: 'retain-on-failure',
    timezoneId: 'America/Chicago',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
    {
      name: 'iphone',
      // iPhone 13 size and touch, rendered by Chrome (WebKit isn't used, so Safari quirks still need a real phone).
      use: { ...devices['iPhone 13'], browserName: 'chromium', channel: 'chrome' },
      grep: /@mobile/,
    },
  ],
  webServer: {
    command: 'node e2e/serve.mjs',
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: { PORT: String(PORT), APP_PASSWORD: E2E_PASSWORD },
  },
});

// Starts the built app (server/dist + web/dist) on a fresh, throwaway data folder for the
// end-to-end tests. Playwright runs this as its web server and stops it afterwards.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'tt-e2e-'));
process.env.DATA_DIR = dataDir;
process.env.PORT ??= '18190';
process.env.HOST = '127.0.0.1';
process.env.TZ = 'America/Chicago';
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
// APP_PASSWORD comes from playwright.config.ts (a test-only value).

const cleanup = () => rmSync(dataDir, { recursive: true, force: true });
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

await import('../server/dist/index.js');

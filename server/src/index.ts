import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { buildApp } from './app';
import { bootstrapAuth, type AuthState } from './auth/bootstrap';
import { LoginRateLimiter } from './auth/rateLimit';
import { purgeExpiredSessions } from './auth/sessions';
import { systemClock } from './clock';
import { ConfigError, loadConfig, type Config } from './config';
import { openDatabase } from './db/connection';
import { migrate } from './db/migrate';
import { seedDefaults } from './db/seed';
import { createLogger } from './logger';
import type { Ctx } from './services/context';
import { rebuildSearch, searchIndexLooksConsistent } from './services/search';

function prepareDataDir(config: Config): void {
  for (const dir of [config.dataDir, config.attachmentsDir, config.backupsDir, config.tmpDir]) {
    mkdirSync(dir, { recursive: true });
  }
  // Nothing can be mid-upload at startup; clear leftovers from a crash.
  for (const name of readdirSync(config.tmpDir)) {
    rmSync(path.join(config.tmpDir, name), { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Configuration error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  const log = createLogger({ level: config.logLevel, timeZone: config.timeZone });
  log.info(`Tower Tracker ${config.appVersion} starting (data: ${config.dataDir}, TZ: ${config.timeZone})`);

  prepareDataDir(config);
  const db = openDatabase(config.dbPath);
  const check = db.pragma('quick_check', { simple: true });
  if (check !== 'ok') {
    log.fatal(`Database integrity check failed: ${String(check)}. Restore from /data/backups or an export.`);
    process.exit(1);
  }
  const applied = migrate(db);
  if (applied.length) log.info(`Applied database migration(s): ${applied.join(', ')}`);

  const ctx: Ctx = { db, clock: systemClock, tz: config.timeZone };
  if (seedDefaults(ctx)) log.info('Seeded default columns, labels and maintenance templates');
  if (!searchIndexLooksConsistent(ctx)) log.info(`Rebuilt search index (${rebuildSearch(ctx)} cards)`);

  const auth: AuthState = await bootstrapAuth(ctx, config.appPassword, log);
  const limiter = new LoginRateLimiter(systemClock);
  const app = await buildApp({ ctx, config, auth, limiter }, log);

  purgeExpiredSessions(ctx);
  const housekeeping = setInterval(() => {
    purgeExpiredSessions(ctx);
    limiter.prune();
  }, 60 * 60 * 1000);
  housekeeping.unref();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received; shutting down`);
    clearInterval(housekeeping);
    try {
      await app.close();
    } catch (err) {
      log.error(err as Error, 'Error while closing HTTP server');
    }
    try {
      // Fold the WAL back into the main file so a copy of /data is self-contained.
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
    } catch (err) {
      log.error(err as Error, 'Error while closing database');
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.port, host: config.host });
  log.info(`Listening on http://${config.host}:${config.port}${config.webDistDir ? '' : ' (API only; no web/dist found)'}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

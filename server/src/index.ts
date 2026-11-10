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
import { prepareData } from './db/prepare';
import { createLogger } from './logger';
import type { Ctx } from './services/context';
import { createClaudeDrafter } from './services/aiDraft';
import { backupBeforeMigrate, dailySnapshot } from './services/backup';
import { pruneNotifications } from './services/notifications';
import { Notifier } from './services/notify';
import { runDueTemplates } from './services/recurring';
import { getGeneralSettings } from './services/settings';
import { localDateOf } from './lib/localdate';

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
  log.info(`Belltower ${config.appVersion} starting (data: ${config.dataDir}, TZ: ${config.timeZone})`);

  prepareDataDir(config);
  const db = openDatabase(config.dbPath);
  const check = db.pragma('quick_check', { simple: true });
  if (check !== 'ok') {
    log.fatal(`Database integrity check failed: ${String(check)}. Restore from /data/backups or an export.`);
    process.exit(1);
  }
  // Upgrades: keep a copy of the database as it was before changing it. No copy, no migration.
  try {
    const copy = await backupBeforeMigrate(db, config.backupsDir, new Date());
    if (copy) log.info(`Saved a copy of the database before upgrading it: ${copy}`);
  } catch (err) {
    log.fatal(err as Error, `Couldn't save a copy of the database before upgrading it, so nothing was changed. Check free space and permissions in ${config.backupsDir}.`);
    process.exit(1);
  }
  const applied = migrate(db);
  if (applied.length) log.info(`Applied database migration(s): ${applied.join(', ')}`);

  const ctx: Ctx = { db, clock: systemClock, tz: config.timeZone };
  // Notifications: events are handled after the change commits (and never break the request).
  const notifier = new Notifier(undefined, undefined, { warn: (message) => log.warn(message) });
  ctx.emit = (event) => {
    setImmediate(() => {
      notifier.handle(ctx, event).catch((err) => log.warn(`Notification failed: ${(err as Error).message}`));
    });
  };
  const prepared = prepareData(ctx);
  if (prepared.seeded) log.info('Seeded default columns, labels and maintenance templates');
  if (prepared.numbered) log.info(`Gave ticket numbers to ${prepared.numbered} existing card(s)`);
  if (prepared.reindexed !== null) log.info(`Rebuilt search index (${prepared.reindexed} cards)`);

  const auth: AuthState = await bootstrapAuth(ctx, config.appPassword, log);
  const limiter = new LoginRateLimiter(systemClock);
  const ai = config.anthropicApiKey
    ? createClaudeDrafter(config.anthropicApiKey, () => getGeneralSettings(ctx).claudeModel || config.aiModel)
    : null;
  log.info(ai ? `Add ticket: Claude drafting on (${ai.model})` : 'Add ticket: Claude drafting off (no ANTHROPIC_API_KEY)');
  const app = await buildApp({ baseCtx: ctx, config, auth, limiter, ai, notifier }, log);

  purgeExpiredSessions(ctx);
  pruneNotifications(ctx);

  // Recurring maintenance: at startup, then every 10 minutes (cards appear shortly after local
  // midnight on their day). Each run is idempotent per occurrence.
  const runTemplates = () => {
    try {
      const r = runDueTemplates(ctx);
      if (r.created.length || r.skipped.length) {
        log.info(`Recurring templates: created ${r.created.length} card(s), skipped ${r.skipped.length} (still open)`);
      }
    } catch (err) {
      log.error(err as Error, 'Recurring templates run failed');
    }
    // One consistent database snapshot per day in /data/backups (last 7 kept).
    dailySnapshot(ctx, config.backupsDir, localDateOf(new Date(), config.timeZone))
      .then((file) => file && log.info(`Daily snapshot written: ${file}`))
      .catch((err) => log.error(err as Error, 'Daily snapshot failed'));
  };
  runTemplates();
  const scheduler = setInterval(runTemplates, 10 * 60 * 1000);
  scheduler.unref();
  // Daily summary: checked every minute, sent once a day per channel at or after the chosen time.
  const digest = setInterval(() => {
    notifier.dailyDigest(ctx, new Date()).catch((err) => log.warn(`Daily summary failed: ${(err as Error).message}`));
  }, 60 * 1000);
  digest.unref();
  const housekeeping = setInterval(() => {
    purgeExpiredSessions(ctx);
    limiter.prune();
    // Personal notifications: read ones after 30 days, any after 90.
    try {
      pruneNotifications(ctx);
    } catch (err) {
      log.warn(`Pruning old notifications failed: ${(err as Error).message}`);
    }
  }, 60 * 60 * 1000);
  housekeeping.unref();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received; shutting down`);
    clearInterval(housekeeping);
    clearInterval(scheduler);
    clearInterval(digest);
    try {
      await app.close();
    } catch (err) {
      log.error(err as Error, 'Error while closing HTTP server');
    }
    // Personal notifications still waiting to be combined go out now (for a few seconds at most).
    try {
      await Promise.race([notifier.flushPersonal(ctx), new Promise((r) => setTimeout(r, 3000))]);
    } catch (err) {
      log.warn(`Sending waiting notifications failed: ${(err as Error).message}`);
    }
    try {
      // Fold the WAL back into the main file so a copy of /data is self-contained.
      ctx.db.pragma('wal_checkpoint(TRUNCATE)');
      ctx.db.close();
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

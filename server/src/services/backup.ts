// Backup export and restore.
//
// Export: every table as rows ordered by id (sessions and the password are never exported; the
// search index is rebuilt on restore). The ZIP adds attachments/<card id>/<uuid> files.
//
// Restore never deletes rows from the live database (the activity log forbids it). Instead it:
//  1. builds a brand-new database file from the export: migrate to the export's schema version,
//     insert every row with its original id, migrate to the current version, check integrity
//     and foreign keys, rebuild search;
//  2. stages the attachment files next to it;
//  3. shows a preview, and only on an explicit confirmation swaps the new file in. The old
//     database and attachments are kept in /data/backups as pre-restore-<time>.
// Your current password and signed-in devices carry over, so a restore never locks you out.

import type Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { z } from 'zod';
import { openDatabase, type DB } from '../db/connection';
import { migrate, schemaVersion } from '../db/migrate';
import { LATEST_SCHEMA_VERSION } from '../db/schema';
import { AppError, badRequest } from '../errors';
import type { Ctx } from './context';
import { assignTicketNumbers } from './cards';
import { seedRequestTypes } from './requestTypes';
import { rebuildSearch } from './search';

/** Keeps the app's old name: it's frozen (docs/BACKUP-FORMAT.md), and every existing backup carries it. */
export const BACKUP_FORMAT = 'tower-tracker-backup';

/** Insert order (parents first). Every table here is exported; nothing else is. */
export const BACKUP_TABLES = [
  'settings',
  'columns',
  'labels',
  'recurring_templates',
  'recurring_template_labels',
  'cards',
  'card_labels',
  'checklists',
  'checklist_items',
  'attachments',
  'card_links',
  'activity',
  'activity_revisions',
  'template_runs',
  'request_types',
  'api_tokens',
] as const;

/** Settings that belong to this installation, not to the data. */
const PRIVATE_SETTINGS = new Set(['password_hash', 'password_source']);

export interface BackupData {
  format: typeof BACKUP_FORMAT;
  schemaVersion: number;
  appVersion: string;
  appTz: string;
  exportedAt: string;
  tables: Record<string, Record<string, unknown>[]>;
}

const BackupSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  schemaVersion: z.number().int().min(1),
  appVersion: z.string().optional(),
  appTz: z.string().optional(),
  exportedAt: z.string(),
  tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
});

export function exportData(ctx: Ctx, appVersion: string): BackupData {
  const tables: BackupData['tables'] = {};
  for (const t of BACKUP_TABLES) {
    const order =
      t === 'settings' ? 'key' : t === 'card_labels' ? 'card_id, label_id' : t === 'recurring_template_labels' ? 'template_id, label_id' : 'id';
    let rows = ctx.db.prepare(`SELECT * FROM ${t} ORDER BY ${order}`).all() as Record<string, unknown>[];
    if (t === 'settings') rows = rows.filter((r) => !PRIVATE_SETTINGS.has(String(r.key)));
    tables[t] = rows;
  }
  return {
    format: BACKUP_FORMAT,
    schemaVersion: schemaVersion(ctx.db),
    appVersion,
    appTz: ctx.tz,
    exportedAt: ctx.clock.now().toISOString(),
    tables,
  };
}

/** Attachment rows of an export, as relative file paths inside the ZIP. */
export function attachmentEntries(data: BackupData): { zipPath: string; cardId: number; storedName: string; size: number }[] {
  return (data.tables.attachments ?? []).map((a) => ({
    zipPath: `attachments/${Number(a.card_id)}/${String(a.stored_name)}`,
    cardId: Number(a.card_id),
    storedName: String(a.stored_name),
    size: Number(a.size_bytes),
  }));
}

// ---------------------------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ZIP_ATTACHMENT = /^attachments\/(\d{1,12})\/([0-9a-f-]{36})$/;

export interface RestorePreview {
  token: string;
  exportedAt: string;
  appVersion: string | null;
  schemaVersion: number;
  counts: Record<string, number>;
  attachments: { expected: number; present: number; missing: number };
  /** Set when the export came from a different time zone. */
  timeZoneWarning: string | null;
  /** Whether the upload carried attachment files (ZIP) or not (JSON only). */
  withFiles: boolean;
}

interface Staged {
  preview: RestorePreview;
  dbPath: string;
  filesDir: string | null;
  createdAt: number;
}

const staged = new Map<string, Staged>();
const STAGE_TTL_MS = 30 * 60 * 1000;

function discard(token: string): void {
  const s = staged.get(token);
  if (!s) return;
  staged.delete(token);
  for (const p of [s.dbPath, `${s.dbPath}-wal`, `${s.dbPath}-shm`]) rmSync(p, { force: true });
  if (s.filesDir) rmSync(s.filesDir, { recursive: true, force: true });
}

export function cancelRestore(token: string): void {
  discard(token);
}

function sweepStaged(): void {
  const now = Date.now();
  for (const [token, s] of staged) if (now - s.createdAt > STAGE_TTL_MS) discard(token);
}

function columnsOf(db: DB, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
}

/** Builds a new database file from an export. Throws AppError(400) on anything invalid. */
export function buildRestoreDb(data: BackupData, dbPath: string, tz: string, clock: Ctx['clock']): Record<string, number> {
  if (data.schemaVersion > LATEST_SCHEMA_VERSION) {
    throw badRequest(
      'validation',
      `This backup is from a newer version of Belltower (schema ${data.schemaVersion}); upgrade the app first`,
    );
  }
  const db = openDatabase(dbPath);
  try {
    migrate(db, { to: data.schemaVersion });
    const counts: Record<string, number> = {};
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        for (const table of BACKUP_TABLES) {
          const rows = data.tables[table] ?? [];
          counts[table] = rows.length;
          if (!rows.length) continue;
          const allowed = columnsOf(db, table);
          for (const row of rows) {
            const cols = Object.keys(row);
            const unknown = cols.filter((c) => !allowed.has(c));
            if (unknown.length) throw badRequest('validation', `Unknown column(s) in ${table}: ${unknown.join(', ')}`);
            if (table === 'settings' && PRIVATE_SETTINGS.has(String(row.key))) continue;
            if (table === 'attachments' && (!UUID.test(String(row.stored_name)) || !Number.isInteger(row.card_id))) {
              throw badRequest('validation', 'Invalid attachment entry in backup');
            }
            const values = cols.map((c) => {
              const v = row[c];
              return typeof v === 'boolean' ? (v ? 1 : 0) : (v as unknown);
            });
            try {
              db.prepare(`INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(
                ...(values as Parameters<Database.Statement['run']>),
              );
            } catch (err) {
              throw badRequest('validation', `Backup row rejected in ${table}: ${(err as Error).message}`);
            }
          }
        }
        const fk = db.pragma('foreign_key_check') as unknown[];
        if (fk.length) throw badRequest('validation', `The backup has ${fk.length} broken reference(s) between tables`);
      })();
    } finally {
      db.pragma('foreign_keys = ON');
    }
    migrate(db);
    const check = db.pragma('integrity_check', { simple: true });
    if (check !== 'ok') throw badRequest('validation', `Restored database failed its integrity check: ${String(check)}`);
    // Never re-seed defaults on top of restored data.
    db.prepare(`INSERT INTO settings (key, value) VALUES ('seeded', '1') ON CONFLICT(key) DO NOTHING`).run();
    assignTicketNumbers({ db, clock, tz }); // backups from before 0.6 have none
    rebuildSearch({ db, clock, tz });
    return counts;
  } finally {
    db.close();
  }
}

/** Reads data.json and the attachment files out of an uploaded ZIP into `filesDir`. */
async function extractZip(zipPath: string, filesDir: string, maxBytes: number): Promise<Buffer> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(zipPath, { lazyEntries: true, validateEntrySizes: true }, (err, z) => (err ? reject(err) : resolve(z!))),
  );
  let json: Buffer | null = null;
  let total = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName;
        const isJson = name === 'data.json';
        const m = ZIP_ATTACHMENT.exec(name);
        if (!isJson && !m) return zip.readEntry(); // ignore anything else
        total += entry.uncompressedSize;
        if (total > maxBytes) return reject(new AppError(413, 'too_large', 'The backup expands to more than the import size limit'));
        zip.openReadStream(entry, (err, stream) => {
          if (err || !stream) return reject(err ?? new Error('unreadable zip entry'));
          if (isJson) {
            const chunks: Buffer[] = [];
            stream.on('data', (c: Buffer) => chunks.push(c));
            stream.on('error', reject);
            stream.on('end', () => {
              json = Buffer.concat(chunks);
              zip.readEntry();
            });
          } else {
            const dir = path.join(filesDir, m![1]!);
            mkdirSync(dir, { recursive: true });
            pipeline(stream, createWriteStream(path.join(dir, m![2]!)))
              .then(() => zip.readEntry())
              .catch(reject);
          }
        });
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  if (!json) throw badRequest('validation', 'This ZIP has no data.json; is it a Belltower backup?');
  return json;
}

function parseBackup(buf: Buffer): BackupData {
  let raw: unknown;
  try {
    raw = JSON.parse(buf.toString('utf8'));
  } catch {
    throw badRequest('validation', "The file isn't valid JSON");
  }
  const parsed = BackupSchema.safeParse(raw);
  if (!parsed.success) throw badRequest('validation', "This isn't a Belltower backup (expected format \"tower-tracker-backup\")");
  return parsed.data as BackupData;
}

/**
 * Stages an uploaded backup (a .json export or a .zip with attachments) for restore and returns
 * a preview. Nothing live changes until confirmRestore().
 */
export async function stageRestore(
  ctx: Ctx,
  opts: { uploadPath: string; isZip: boolean; tmpDir: string; attachmentsDir: string; maxBytes: number },
): Promise<RestorePreview> {
  sweepStaged();
  const token = randomBytes(16).toString('hex');
  const dbPath = path.join(opts.tmpDir, `restore-${token}.db`);
  const filesDir = opts.isZip ? path.join(opts.tmpDir, `restore-${token}-files`) : null;
  try {
    const buf = opts.isZip ? await extractZip(opts.uploadPath, filesDir!, opts.maxBytes) : readFileSync(opts.uploadPath);
    const data = parseBackup(buf);
    const counts = buildRestoreDb(data, dbPath, ctx.tz, ctx.clock);

    // Which attachment files exist for the rows: in the ZIP, or (JSON-only) already on disk here.
    const entries = attachmentEntries(data);
    let present = 0;
    const wanted = new Set<string>();
    for (const e of entries) {
      const base = filesDir ?? opts.attachmentsDir;
      const p = path.join(base, String(e.cardId), e.storedName);
      wanted.add(p);
      if (existsSync(p) && statSync(p).size === e.size) present++;
    }
    if (filesDir) {
      // Drop files no row refers to.
      for (const card of existsSync(filesDir) ? readdirSync(filesDir) : []) {
        for (const f of readdirSync(path.join(filesDir, card))) {
          const p = path.join(filesDir, card, f);
          if (!wanted.has(p)) rmSync(p, { force: true });
        }
      }
    }
    const preview: RestorePreview = {
      token,
      exportedAt: data.exportedAt,
      appVersion: data.appVersion ?? null,
      schemaVersion: data.schemaVersion,
      counts,
      attachments: { expected: entries.length, present, missing: entries.length - present },
      timeZoneWarning:
        data.appTz && data.appTz !== ctx.tz
          ? `This backup was made with TZ=${data.appTz}; this server uses ${ctx.tz}. Due dates stay as written.`
          : null,
      withFiles: opts.isZip,
    };
    staged.set(token, { preview, dbPath, filesDir, createdAt: Date.now() });
    return preview;
  } catch (err) {
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(p, { force: true });
    if (filesDir) rmSync(filesDir, { recursive: true, force: true });
    if (err instanceof AppError) throw err;
    throw badRequest('validation', `Couldn't read the backup: ${(err as Error).message}`);
  }
}

/**
 * Swaps the staged database (and files) in. Synchronous from start to finish, so no request can
 * run against a half-swapped state. Returns the path of the kept pre-restore copy.
 */
export function confirmRestore(
  ctx: Ctx,
  token: string,
  opts: { dbPath: string; attachmentsDir: string; backupsDir: string },
): { previousDb: string } {
  const s = staged.get(token);
  if (!s) throw new AppError(404, 'not_found', 'That restore has expired; upload the backup again');

  // Carry the current password and signed-in devices into the restored database.
  const next = openDatabase(s.dbPath);
  try {
    const keep = ctx.db.prepare(`SELECT key, value FROM settings WHERE key IN ('password_hash', 'password_source')`).all() as {
      key: string;
      value: string;
    }[];
    const sessions = ctx.db.prepare('SELECT * FROM sessions').all() as Record<string, unknown>[];
    next.transaction(() => {
      for (const k of keep) {
        next.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k.key, k.value);
      }
      for (const row of sessions) {
        const cols = Object.keys(row);
        next.prepare(`INSERT OR IGNORE INTO sessions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(
          ...(Object.values(row) as Parameters<Database.Statement['run']>),
        );
      }
    })();
    next.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    next.close();
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  mkdirSync(opts.backupsDir, { recursive: true });
  const previousDb = path.join(opts.backupsDir, `pre-restore-${stamp}.db`);

  ctx.db.pragma('wal_checkpoint(TRUNCATE)');
  ctx.db.close();
  renameSync(opts.dbPath, previousDb);
  for (const ext of ['-wal', '-shm']) rmSync(opts.dbPath + ext, { force: true });
  renameSync(s.dbPath, opts.dbPath);
  for (const ext of ['-wal', '-shm']) rmSync(s.dbPath + ext, { force: true });
  if (s.filesDir) {
    if (existsSync(opts.attachmentsDir)) renameSync(opts.attachmentsDir, path.join(opts.backupsDir, `pre-restore-${stamp}-attachments`));
    if (existsSync(s.filesDir)) renameSync(s.filesDir, opts.attachmentsDir);
    else mkdirSync(opts.attachmentsDir, { recursive: true });
  }
  ctx.db = openDatabase(opts.dbPath);
  migrate(ctx.db);
  seedRequestTypes(ctx); // a backup from before 0.9 has none
  staged.delete(token);
  pruneBackups(opts.backupsDir, /^pre-restore-.*\.db$/, 5, /-attachments$/);
  return { previousDb };
}

/** Keeps the newest `keep` files matching `pattern` (and their `-attachments` folders). */
export function pruneBackups(dir: string, pattern: RegExp, keep: number, companion?: RegExp): void {
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter((f) => pattern.test(f)).sort().reverse();
  for (const f of files.slice(keep)) {
    rmSync(path.join(dir, f), { force: true });
    if (companion) {
      const folder = f.replace(/\.db$/, '-attachments');
      if (companion.test(folder)) rmSync(path.join(dir, folder), { recursive: true, force: true });
    }
  }
}

/** Nightly snapshot: one consistent copy of the database per day in /data/backups, last 7 kept. */
export async function dailySnapshot(ctx: Ctx, backupsDir: string, today: string): Promise<string | null> {
  mkdirSync(backupsDir, { recursive: true });
  const file = path.join(backupsDir, `tower-${today}.db`);
  if (existsSync(file)) return null;
  const tmp = `${file}.${randomUUID()}.part`;
  try {
    await ctx.db.backup(tmp);
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
  pruneBackups(backupsDir, /^tower-\d{4}-\d{2}-\d{2}\.db$/, 7);
  return file;
}

/**
 * Before an upgrade changes the database: a consistent copy in /data/backups named
 * pre-migrate-v<from>-to-v<to>-<timestamp>.db (last 5 kept). Returns null when nothing needs
 * migrating (or for a brand-new database). Throws if the copy can't be made; the caller must not
 * migrate then.
 */
export async function backupBeforeMigrate(db: DB, backupsDir: string, now: Date, latest = LATEST_SCHEMA_VERSION): Promise<string | null> {
  const from = schemaVersion(db);
  if (from === 0 || from >= latest) return null;
  mkdirSync(backupsDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const file = path.join(backupsDir, `pre-migrate-v${from}-to-v${latest}-${stamp}.db`);
  const tmp = `${file}.${randomUUID()}.part`;
  try {
    await db.backup(tmp);
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
  pruneBackups(backupsDir, /^pre-migrate-v\d+-to-v\d+-.*\.db$/, 5);
  return file;
}

/** For tests and diagnostics: a content hash of a file. */
export function sha256File(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}


import Database from 'better-sqlite3';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, schemaVersion } from '../src/db/migrate';
import { LATEST_SCHEMA_VERSION } from '../src/db/schema';
import { backupBeforeMigrate } from '../src/services/backup';

let dir: string;
let db: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tt-premigrate-'));
  db = new Database(path.join(dir, 'tower.db'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const backups = () => path.join(dir, 'backups');
const T = new Date('2026-10-27T18:00:00.000Z');

describe('copy before migrating', () => {
  it('copies an older database, unchanged, before it is upgraded', async () => {
    migrate(db, { to: 2 });
    db.prepare(`INSERT INTO columns (name, position, role, created_at) VALUES ('Triage', 0, 'triage', '2026-10-10T15:00:00.000Z')`).run();

    const file = await backupBeforeMigrate(db, backups(), T);
    expect(path.basename(file!)).toBe(`pre-migrate-v2-to-v${LATEST_SCHEMA_VERSION}-2026-10-27T18-00-00-000Z.db`);
    migrate(db);

    const copy = new Database(file!, { readonly: true });
    expect(schemaVersion(copy)).toBe(2);
    expect(copy.prepare('SELECT name FROM columns').pluck().all()).toEqual(['Triage']);
    copy.close();
  });

  it('does nothing for a new or already current database', async () => {
    expect(await backupBeforeMigrate(db, backups(), T)).toBeNull(); // brand new (v0)
    migrate(db);
    expect(await backupBeforeMigrate(db, backups(), T)).toBeNull(); // up to date
  });

  it('keeps the last 5 copies', async () => {
    migrate(db, { to: 1 });
    for (let i = 0; i < 7; i++) {
      await backupBeforeMigrate(db, backups(), new Date(T.getTime() + i * 60_000));
    }
    const files = readdirSync(backups()).filter((f) => f.startsWith('pre-migrate-')).sort();
    expect(files).toHaveLength(5);
    expect(files[0]).toContain('18-02-00');
  });

  it('throws when the copy cannot be written (so the caller does not migrate)', async () => {
    migrate(db, { to: 1 });
    writeFileSync(backups(), 'not a folder');
    await expect(backupBeforeMigrate(db, backups(), T)).rejects.toThrow();
    expect(schemaVersion(db)).toBe(1);
  });
});

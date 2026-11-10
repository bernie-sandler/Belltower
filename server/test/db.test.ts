import { describe, expect, it } from 'vitest';
import { parseTrustProxy, loadConfig } from '../src/config';
import { openDatabase } from '../src/db/connection';
import { migrate, schemaVersion, syncGuards } from '../src/db/migrate';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, type Migration } from '../src/db/schema';
import { addDays, addMonths, dayOfWeek, localDateOf } from '../src/lib/localdate';
import { createCard } from '../src/services/cards';
import { rebuildSearch, searchIndexLooksConsistent } from '../src/services/search';
import { makeCtx } from './helpers';

describe('migrations', () => {
  it('migrates a fresh database to the latest version with guards in place', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    const triggers = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`).pluck().all();
    expect(triggers).toEqual([
      'activity_guard_update',
      'activity_no_delete',
      'activity_no_replace',
      'activity_revisions_no_delete',
      'activity_revisions_no_replace',
      'activity_revisions_no_update',
    ]);
    expect(migrate(db)).toEqual([]); // idempotent
    db.close();
  });

  it('refuses to open a database from a newer app version', () => {
    const db = openDatabase(':memory:');
    db.pragma('user_version = 999');
    expect(() => migrate(db)).toThrow(/newer/);
    db.close();
  });

  it('lets a later migration rebuild the activity table (guards are dropped around it)', () => {
    const t = makeCtx();
    createCard(t.ctx, { title: 'History survives' });
    const rebuild: Migration = {
      version: LATEST_SCHEMA_VERSION + 1,
      name: 'test rebuild',
      // Keeps activity.id the primary key: notifications refer to it.
      sql: `CREATE TABLE activity_new (id INTEGER PRIMARY KEY, card_id INTEGER, kind TEXT, type TEXT, data TEXT, body_md TEXT,
              occurred_at TEXT, created_at TEXT, edited_at TEXT, retracted_at TEXT, user_id INTEGER, token_id INTEGER);
            INSERT INTO activity_new SELECT * FROM activity;
            DROP TABLE activity_revisions; DROP TABLE activity;
            ALTER TABLE activity_new RENAME TO activity;
            CREATE TABLE activity_revisions (id INTEGER PRIMARY KEY, activity_id INTEGER, body_md TEXT, occurred_at TEXT, revised_at TEXT, user_id INTEGER);`,
    };
    migrate(t.ctx.db, { migrations: [...MIGRATIONS, rebuild] });
    expect(t.ctx.db.prepare('SELECT count(*) FROM activity').pluck().get()).toBe(1);
    expect(() => t.ctx.db.exec('DELETE FROM activity')).toThrow(/append-only/);
    t.close();
  });

  it('only freezes the work-log author columns once they exist (older schemas still update)', () => {
    // A trigger naming a missing column would make every UPDATE on activity fail at schema 8, which
    // upgrades and restores of older data go through.
    const db = openDatabase(':memory:');
    migrate(db, { to: 8 });
    db.exec(`INSERT INTO columns (name, position, created_at) VALUES ('Triage', 0, '2026-10-01T00:00:00.000Z');
             INSERT INTO cards (column_id, title, created_at, updated_at) VALUES (1, 'x', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
             INSERT INTO activity (card_id, kind, type, body_md, occurred_at, created_at)
               VALUES (1, 'worklog', 'worklog', 'first', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');`);
    const edit = (body: string) => db.prepare('UPDATE activity SET body_md = ? WHERE id = 1').run(body);
    edit('edited at schema 8');
    syncGuards(db); // what startup does on a database that needs no migration
    edit('edited again');
    expect(() => db.exec(`UPDATE activity SET type = 'moved' WHERE id = 1`)).toThrow(/append-only/);

    migrate(db);
    edit('edited at the current schema');
    expect(() => db.exec('UPDATE activity SET token_id = 5 WHERE id = 1')).toThrow(/append-only/);
    expect(db.prepare('SELECT body_md FROM activity').pluck().get()).toBe('edited at the current schema');
    db.close();
  });

  it('keeps the search index consistent and can rebuild it', () => {
    const t = makeCtx();
    createCard(t.ctx, { title: 'One' });
    createCard(t.ctx, { title: 'Two' });
    expect(searchIndexLooksConsistent(t.ctx)).toBe(true);
    t.ctx.db.exec('DELETE FROM card_search');
    expect(searchIndexLooksConsistent(t.ctx)).toBe(false);
    expect(rebuildSearch(t.ctx)).toBe(2);
    expect(t.ctx.db.prepare(`SELECT rowid FROM card_search WHERE card_search MATCH '"two"*'`).pluck().all()).toHaveLength(1);
    t.close();
  });
});

describe('local dates', () => {
  it('does calendar math without time-zone drift', () => {
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02'); // DST ends in Chicago on Nov 1
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09'); // DST starts on Mar 8
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-02-28', 1, 31)).toBe('2026-03-31');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(dayOfWeek('2026-10-10')).toBe(6); // Saturday
    expect(dayOfWeek('2026-10-11')).toBe(0);
  });

  it('computes "today" in the app time zone', () => {
    // 03:30 UTC on Oct 11 is still Oct 10 in Chicago.
    expect(localDateOf(new Date('2026-10-11T03:30:00Z'), 'America/Chicago')).toBe('2026-10-10');
    expect(localDateOf(new Date('2026-10-11T03:30:00Z'), 'Pacific/Auckland')).toBe('2026-10-11');
  });
});

describe('config', () => {
  it('accepts only IP/CIDR lists for TRUST_PROXY', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('192.168.1.20')).toEqual(['192.168.1.20']);
    expect(parseTrustProxy('192.168.1.0/24, 100.64.0.0/10, fd7a::/48')).toEqual([
      '192.168.1.0/24',
      '100.64.0.0/10',
      'fd7a::/48',
    ]);
    for (const bad of ['true', '*', '1', 'proxy.local', '192.168.1.0/33']) {
      expect(() => parseTrustProxy(bad)).toThrow(/TRUST_PROXY/);
    }
  });

  it('validates TZ and sizes', () => {
    expect(() => loadConfig({ TZ: 'Mars/Olympus' })).toThrow(/TZ/);
    expect(() => loadConfig({ MAX_UPLOAD_MB: 'lots' })).toThrow(/MAX_UPLOAD_MB/);
    const c = loadConfig({ TZ: 'America/Chicago', DATA_DIR: '/data' });
    expect(c.maxUploadBytes).toBe(25 * 1024 * 1024);
    expect(c.port).toBe(8080);
  });
});

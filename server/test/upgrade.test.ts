// Upgrades from every older version. 1.0 promises that a database or backup from any earlier
// release keeps working, so each schema version gets the same two checks:
//  - a database left by that version, upgraded in place the way startup does it;
//  - a backup exported by that version, restored into this one.
// The old databases are built with the real migrations stopped at that version, so the tables
// match what that release created.

import { SearchQuery, type ChecklistItemState } from '@tt/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../src/clock';
import { openDatabase, type DB } from '../src/db/connection';
import { migrate, schemaVersion } from '../src/db/migrate';
import { prepareData } from '../src/db/prepare';
import { LATEST_SCHEMA_VERSION } from '../src/db/schema';
import { listActivity } from '../src/services/activity';
import { backupBeforeMigrate, buildRestoreDb, exportData, type BackupData } from '../src/services/backup';
import { completeCard, createCard, getBoard, getCard, updateCard } from '../src/services/cards';
import { updateChecklistItem } from '../src/services/checklists';
import type { Ctx } from '../src/services/context';
import { createLink } from '../src/services/links';
import { searchCards } from '../src/services/search';
import { createToken } from '../src/services/tokens';
import { addWorklog } from '../src/services/worklog';

const OLD_VERSIONS = Array.from({ length: LATEST_SCHEMA_VERSION - 1 }, (_, i) => i + 1);
const clock = fixedClock('2026-10-20T15:00:00.000Z');
const TZ = 'America/Chicago';

const dirs: string[] = [];
const dbs: DB[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) if (db.open) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'tt-upgrade-'));
  dirs.push(d);
  return d;
}

const at = (day: number, hour = 15) => `2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;

/**
 * What a homelab board looked like under schema `v`, written with plain SQL as that version's code
 * would have: columns, labels, cards in every state, a blocking link, a checklist, an attachment,
 * history with an edited work-log entry, and a recurring template that has run.
 */
function oldDatabase(v: number): DB {
  const db = openDatabase(path.join(tempDir(), 'tower.db'));
  dbs.push(db);
  migrate(db, { to: v });
  const run = (sql: string, ...args: unknown[]) => Number(db.prepare(sql).run(...args).lastInsertRowid);

  run(`INSERT INTO settings (key, value) VALUES ('seeded', '1')`);
  const cols = ['Triage', 'Backlog', 'In Progress', 'Blocked/Waiting', 'Done'].map((name, i) =>
    run('INSERT INTO columns (name, position, role, created_at) VALUES (?, ?, ?, ?)', name, i, i === 0 ? 'triage' : i === 4 ? 'done' : null, at(1)),
  );
  const [triage, backlog, , blocked, done] = cols as [number, number, number, number, number];
  const hardware = run(`INSERT INTO labels (name, color, position, created_at) VALUES ('Hardware', '#f87168', 0, ?)`, at(1));

  const card = (column: number, title: string, day: number, extra: Record<string, unknown> = {}) => {
    const fields = { column_id: column, title, position: day, created_at: at(day), updated_at: at(day), ...extra };
    const keys = Object.keys(fields);
    const id = run(`INSERT INTO cards (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...Object.values(fields));
    run(`INSERT INTO activity (card_id, kind, type, data, occurred_at, created_at) VALUES (?, 'event', 'created', ?, ?, ?)`, id, JSON.stringify({ column: { id: column, name: 'Triage' } }), at(day), at(day));
    return id;
  };
  const disk = card(blocked, 'Drive 3 CRC errors', 2, { priority: 'high', description_md: 'UDMA CRC count climbing', ...(v >= 2 ? { severity: 'major' } : {}) });
  const order = card(backlog, 'Order a SATA cable', 2);
  const fan = card(done, 'Replace the case fan', 3, { completed_at: at(4) });
  card(triage, 'Archived idea', 5, { archived_at: at(6) });

  run('INSERT INTO card_labels (card_id, label_id) VALUES (?, ?)', disk, hardware);
  run(`INSERT INTO card_links (from_card_id, to_card_id, type, created_at) VALUES (?, ?, 'blocks', ?)`, order, disk, at(2));
  const list = run(`INSERT INTO checklists (card_id, title, position, created_at) VALUES (?, 'Steps', 0, ?)`, disk, at(2));
  const smart = run(`INSERT INTO checklist_items (checklist_id, text, checked, checked_at, position, created_at) VALUES (?, 'Run a SMART long test', 1, ?, 0, ?)`, list, at(3), at(2));
  if (v >= 8) {
    // 1.4 stores the mark as a state, and an item can be failed (checked stays 0).
    db.prepare(`UPDATE checklist_items SET state = 'done' WHERE id = ?`).run(smart);
    run(`INSERT INTO checklist_items (checklist_id, text, state, checked_at, position, created_at) VALUES (?, 'Swap the backplane', 'failed', ?, 1, ?)`, list, at(4), at(2));
  }
  run(
    `INSERT INTO attachments (card_id, original_name, stored_name, mime_type, kind, size_bytes, sha256, created_at)
     VALUES (?, 'smart.txt', '0f8fad5b-d9cb-469f-a165-70867728950e', 'text/plain', 'text', 10, ?, ?)`,
    disk,
    'a'.repeat(64),
    at(2),
  );
  const log = run(
    `INSERT INTO activity (card_id, kind, type, data, body_md, occurred_at, created_at, edited_at) VALUES (?, 'worklog', 'worklog', '{}', 'Reseated the SATA cable on drive 3', ?, ?, ?)`,
    disk,
    at(3),
    at(3),
    at(4),
  );
  run(`INSERT INTO activity_revisions (activity_id, body_md, occurred_at, revised_at) VALUES (?, 'Reseated the cable', ?, ?)`, log, at(3), at(4));
  const tpl = run(
    `INSERT INTO recurring_templates (title, interval_unit, interval_count, start_date, next_run_date, enabled, created_at, updated_at)
     VALUES ('Monthly parity check', 'month', 1, '2026-10-01', '2026-11-01', 1, ?, ?)`,
    at(1),
    at(1),
  );
  run(`INSERT INTO recurring_template_labels (template_id, label_id) VALUES (?, ?)`, tpl, hardware);
  const parity = card(triage, 'Monthly parity check', 1, { source: 'recurring', template_id: tpl });
  run(`INSERT INTO template_runs (template_id, occurrence_date, outcome, card_id, ran_at) VALUES (?, '2026-10-01', 'created', ?, ?)`, tpl, parity, at(1));

  if (v >= 4) {
    const work = card(backlog, 'Storage refresh', 2, { kind: 'work' });
    db.prepare('UPDATE cards SET parent_id = ? WHERE id = ?').run(work, order);
  }
  if (v >= 3) {
    // Numbered by that version at startup.
    const ids = db.prepare('SELECT id FROM cards ORDER BY id').pluck().all() as number[];
    ids.forEach((id, i) => db.prepare('UPDATE cards SET ticket_no = ? WHERE id = ?').run(`261001-${i + 1}`, id));
  }
  if (v >= 5) {
    run(`INSERT INTO settings (key, value) VALUES ('request_types_seeded', '1')`);
    run(
      `INSERT INTO request_types (name, title_pattern, fields, position, created_at, updated_at) VALUES ('Plex', 'Plex – {summary}', '[]', 0, ?, ?)`,
      at(1),
      at(1),
    );
    run(`INSERT INTO api_tokens (name, token_hash, prefix, can_complete, created_at) VALUES ('Uptime Kuma', ?, 'tt_abcd', 1, ?)`, 'b'.repeat(64), at(1));
  }
  if (v >= 7) {
    run(`INSERT INTO api_tokens (name, token_hash, prefix, can_complete, scope, created_at) VALUES ('Homepage', ?, 'tt_efgh', 0, 'read', ?)`, 'c'.repeat(64), at(1));
  }
  return db;
}

const count = (db: DB, table: string) => db.prepare(`SELECT count(*) FROM ${table}`).pluck().get() as number;
const COUNTED = ['columns', 'labels', 'cards', 'card_labels', 'card_links', 'checklists', 'checklist_items', 'attachments', 'activity', 'activity_revisions', 'recurring_templates', 'template_runs'];

/**
 * Everything the app does with a board still works on the upgraded data. `marks` is the drive card's
 * checklist as it should come back (item text → state).
 */
function checkWorks(ctx: Ctx, marks: Record<string, ChecklistItemState>) {
  const db = ctx.db;
  expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
  expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  expect(db.pragma('foreign_key_check')).toEqual([]);

  const id = (title: string) => db.prepare('SELECT id FROM cards WHERE title = ?').pluck().get(title) as number;
  const board = getBoard(ctx);
  expect(board.cards.map((c) => c.title)).not.toContain('Archived idea');
  for (const c of board.cards) expect(c.ticketNo).toMatch(/^\d{6}-\d+$/);
  const disk = board.cards.find((c) => c.title === 'Drive 3 CRC errors')!;
  expect(disk).toMatchObject({ priority: 'high', blockedBy: 1, attachmentCount: 1, resolution: null });
  const detail = getCard(ctx, disk.id);
  expect(detail.description).toBe('UDMA CRC count climbing');

  // Checked items from before 1.4 are done; the tile counts done and failed as answered.
  const items = detail.checklists[0]!.items;
  expect(Object.fromEntries(items.map((i) => [i.text, i.state]))).toEqual(marks);
  expect(items[0]).toMatchObject({ text: 'Run a SMART long test', state: 'done', checked: true, checkedAt: at(3) });
  for (const i of items) expect(i.checkedAt === null, i.text).toBe(i.state === 'open');
  const marked = (...states: ChecklistItemState[]) => items.filter((i) => states.includes(i.state)).length;
  expect(disk).toMatchObject({
    checklistTotal: items.length,
    checklistDone: marked('done', 'failed'),
    checklistFailed: marked('failed'),
    checklistUnverified: marked('unverified'),
  });

  // Search covers what the old version stored (work log, checklist, description).
  expect(searchCards(ctx, SearchQuery.parse({ q: 'reseated cable' })).map((r) => r.id)).toEqual([disk.id]);
  expect(searchCards(ctx, SearchQuery.parse({ q: 'SMART' })).map((r) => r.id)).toContain(disk.id);

  // History stays append-only.
  expect(() => db.prepare('DELETE FROM activity WHERE card_id = ?').run(disk.id)).toThrow(/append-only/);
  expect(listActivity(ctx, disk.id).find((e) => e.kind === 'worklog')!.bodyMd).toBe('Reseated the SATA cable on drive 3');

  // Newer features on old cards: severity, checklist marks, completing a blocker then the blocked card, resolutions.
  updateCard(ctx, disk.id, { severity: 'blocker' });
  expect(updateChecklistItem(ctx, items[0]!.id, { state: 'unverified' })).toMatchObject({ checklistUnverified: 1 });
  completeCard(ctx, id('Order a SATA cable'), { includeChildren: false, resolution: { reason: 'Fixed', note: 'Arrived.' } });
  const doneDisk = completeCard(ctx, disk.id, { includeChildren: false, resolution: { reason: 'Fixed', note: 'New cable.' } }).card;
  expect(doneDisk).toMatchObject({ severity: 'blocker', resolution: 'Fixed', resolutionNote: 'New cable.' });
  const fresh = createCard(ctx, { title: 'Made after the upgrade' });
  expect(fresh.ticketNo).toMatch(/^261020-\d+$/);
  createLink(ctx, fresh.id, id('Replace the case fan'), 'relates');
  addWorklog(ctx, fresh.id, { bodyMd: 'Still works' });
  createToken(ctx, { name: 'New token', canComplete: false });
  createToken(ctx, { name: 'Dashboard', canComplete: true, scope: 'read' });

  // Tokens from before read-only tokens existed keep doing everything they did. Homepage was made
  // read-only (schema 7 data on), Dashboard just now.
  const scopes = (d: DB) => d.prepare('SELECT name, scope, can_complete FROM api_tokens ORDER BY id').all() as { name: string; scope: string }[];
  for (const tk of scopes(db)) if (tk.name !== 'Dashboard' && tk.name !== 'Homepage') expect(tk.scope, tk.name).toBe('full');

  // And it can be backed up and restored again, read-only tokens and checklist marks included.
  const data = exportData(ctx, 'test');
  const file = path.join(tempDir(), 'restored.db');
  const counts = buildRestoreDb(data, file, ctx.tz, ctx.clock);
  expect(counts.cards).toBe(count(db, 'cards'));
  const again = openDatabase(file);
  dbs.push(again);
  expect(again.prepare('SELECT scope, can_complete FROM api_tokens WHERE name = ?').get('Dashboard')).toEqual({ scope: 'read', can_complete: 0 });
  expect(scopes(again)).toEqual(scopes(db));
  const itemMarks = (d: DB) => d.prepare('SELECT id, state, checked, checked_at FROM checklist_items ORDER BY id').all();
  expect(itemMarks(again)).toEqual(itemMarks(db));
}

describe('upgrading a database left by an older version', () => {
  it.each(OLD_VERSIONS)('from schema %i', async (v) => {
    const db = oldDatabase(v);
    const before = Object.fromEntries(COUNTED.map((t) => [t, count(db, t)]));

    // Startup: a copy first, then migrate and prepare.
    const backups = tempDir();
    expect(await backupBeforeMigrate(db, backups, new Date(at(20)))).toMatch(new RegExp(`pre-migrate-v${v}-to-v${LATEST_SCHEMA_VERSION}-`));
    migrate(db);
    const ctx: Ctx = { db, clock, tz: TZ };
    const prepared = prepareData(ctx);

    expect(prepared.seeded).toBe(false); // never re-seeds an existing board
    expect(prepared.numbered).toBe(v >= 3 ? 0 : before.cards);
    for (const t of COUNTED) expect(count(db, t), t).toBe(before[t]);
    expect(count(db, 'request_types')).toBe(v >= 5 ? 1 : 3); // older installs get the default types
    checkWorks(ctx, { 'Run a SMART long test': 'done' });
  });
});

/** Turns a current export into what schema `v` exported: no tables or columns added after it, and no values it couldn't store. */
function asExportFrom(data: BackupData, v: number): BackupData {
  const out: BackupData = JSON.parse(JSON.stringify(data));
  out.schemaVersion = v;
  const dropColumns: [number, string, string[]][] = [
    [2, 'cards', ['severity']],
    [3, 'cards', ['ticket_no']],
    [4, 'cards', ['kind', 'parent_id']],
    [6, 'cards', ['resolution', 'resolution_md']],
    [7, 'api_tokens', ['scope']],
    [8, 'checklist_items', ['state']],
  ];
  for (const [added, table, columns] of dropColumns) {
    if (v >= added) continue;
    for (const row of out.tables[table] ?? []) for (const c of columns) delete row[c];
  }
  if (v < 5) {
    delete out.tables.request_types;
    delete out.tables.api_tokens;
  }
  if (v < 8) {
    // Before 1.4 only checked items had a time.
    for (const row of out.tables.checklist_items ?? []) if (row.checked === 0) row.checked_at = null;
  }
  return out;
}

describe('restoring a backup exported by an older version', () => {
  it.each(OLD_VERSIONS)('from schema %i', (v) => {
    const db = oldDatabase(LATEST_SCHEMA_VERSION); // the same board, as an export of each version would hold it
    const src: Ctx = { db, clock, tz: TZ };
    prepareData(src);
    const data = asExportFrom(exportData(src, `schema-${v}`), v);

    const file = path.join(tempDir(), 'restored.db');
    const counts = buildRestoreDb(data, file, TZ, clock);
    expect(counts.cards).toBe(count(db, 'cards'));
    const restored = openDatabase(file);
    dbs.push(restored);
    for (const tbl of COUNTED) expect(count(restored, tbl), tbl).toBe(count(db, tbl));
    // Before 1.4 the failed item was just not checked.
    checkWorks({ db: restored, clock, tz: TZ }, { 'Run a SMART long test': 'done', 'Swap the backplane': 'open' });
  });
});

describe('restoring a backup exported by this version', () => {
  it('keeps every checklist mark, failed included', () => {
    const db = oldDatabase(LATEST_SCHEMA_VERSION);
    const src: Ctx = { db, clock, tz: TZ };
    prepareData(src);
    const file = path.join(tempDir(), 'restored.db');
    buildRestoreDb(exportData(src, 'current'), file, TZ, clock);
    const restored = openDatabase(file);
    dbs.push(restored);
    checkWorks({ db: restored, clock, tz: TZ }, { 'Run a SMART long test': 'done', 'Swap the backplane': 'failed' });
  });
});

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, schemaVersion } from '../src/db/migrate';
import { MIGRATIONS } from '../src/db/schema';
import { listActivity } from '../src/services/activity';
import { createCard, getBoard, getCard, sortColumnByPriority, updateCard } from '../src/services/cards';
import { client, makeApp, makeCtx, setupAndLogin } from './helpers';

let t: ReturnType<typeof makeCtx>;
beforeEach(() => {
  t = makeCtx();
});
afterEach(() => t.close());

describe('severity', () => {
  it('is set on create and update, and changes are logged', () => {
    const card = createCard(t.ctx, { title: 'Array offline', priority: 'critical', severity: 'blocker' });
    expect(card).toMatchObject({ priority: 'critical', severity: 'blocker' });
    const d = updateCard(t.ctx, card.id, { severity: 'major' });
    expect(d.severity).toBe('major');
    expect(listActivity(t.ctx, card.id)[0]).toMatchObject({
      type: 'severity_changed',
      data: { from: 'blocker', to: 'major' },
    });
    expect(updateCard(t.ctx, card.id, { severity: null }).severity).toBeNull();
  });

  it('is validated by the database', () => {
    const card = createCard(t.ctx, { title: 'A' });
    expect(() => t.ctx.db.prepare(`UPDATE cards SET severity = 'S9' WHERE id = ?`).run(card.id)).toThrow(/CHECK/);
  });
});

describe('sort by priority', () => {
  it('orders P0 → P3, then S1 → S4, with unset last and ties kept in place', () => {
    const mk = (title: string, priority: 'critical' | 'high' | 'medium' | 'low' | null, severity: 'blocker' | 'major' | 'minor' | 'trivial' | null) =>
      createCard(t.ctx, { title, priority, severity });
    mk('none', null, null);
    mk('P2', 'medium', null);
    mk('P1 S3', 'high', 'minor');
    mk('P0', 'critical', null);
    mk('P1 S1', 'high', 'blocker');
    mk('S2 only', null, 'major');
    mk('P2 again', 'medium', null);
    const triage = getBoard(t.ctx).columns[0]!.id;
    const before = listActivity(t.ctx, 1).length;
    sortColumnByPriority(t.ctx, triage);
    expect(getBoard(t.ctx).cards.filter((c) => c.columnId === triage).map((c) => c.title)).toEqual([
      'P0',
      'P1 S1',
      'P1 S3',
      'P2',
      'P2 again',
      'S2 only',
      'none',
    ]);
    expect(listActivity(t.ctx, 1).length).toBe(before); // a reorder isn't logged
  });

  it('is available over HTTP', async () => {
    const app = await makeApp();
    try {
      const api = client(app.app, await setupAndLogin(app));
      const a = (await api('POST', '/api/cards', { title: 'low', priority: 'low' })).json();
      const b = (await api('POST', '/api/cards', { title: 'crit', priority: 'critical', severity: 'blocker' })).json();
      const res = await api('POST', `/api/columns/${a.columnId}/sort-by-priority`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ orders: { [a.columnId]: [b.id, a.id] } });
      expect((await api('PATCH', `/api/cards/${a.id}`, { expectedVersion: 1, severity: 'S2' })).statusCode).toBe(400);
    } finally {
      await app.shutdown();
    }
  });
});

describe('migration 2', () => {
  it('adds severity to an existing database without touching its cards', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tt-mig-'));
    const db = new Database(path.join(dir, 'old.db'));
    db.pragma('foreign_keys = ON');
    migrate(db, { migrations: MIGRATIONS.slice(0, 1) });
    expect(schemaVersion(db)).toBe(1);
    const now = '2026-10-10T15:00:00.000Z';
    db.prepare(`INSERT INTO columns (name, position, role, created_at) VALUES ('Triage', 0, 'triage', ?)`).run(now);
    db.prepare(
      `INSERT INTO cards (column_id, title, priority, position, created_at, updated_at) VALUES (1, 'Old card', 'high', 0, ?, ?)`,
    ).run(now, now);
    expect(migrate(db)).toEqual(MIGRATIONS.slice(1).map((m) => m.version));
    const ctx = { db, clock: t.clock, tz: 'America/Chicago' };
    expect(getCard(ctx, 1)).toMatchObject({ title: 'Old card', priority: 'high', severity: null });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

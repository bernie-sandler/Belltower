import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate';
import { MIGRATIONS } from '../src/db/schema';
import { AppError } from '../src/errors';
import { listActivity } from '../src/services/activity';
import { listCards } from '../src/services/cardParts';
import {
  archiveCard,
  completeCard,
  createCard,
  deleteCard,
  getBoard,
  getCard,
  getCardTile,
  moveCard,
  restoreCard,
  undeleteCard,
  updateCard,
} from '../src/services/cards';
import { setBlockedColumn } from '../src/services/columns';
import { createLink } from '../src/services/links';
import { client, columnId, makeApp, makeCtx, setupAndLogin, type TestApp } from './helpers';

let t: ReturnType<typeof makeCtx>;
beforeEach(() => {
  t = makeCtx();
});
afterEach(() => t.close());

function failure(fn: () => unknown): AppError {
  try {
    fn();
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error('expected an AppError');
}

const done = () => columnId(t.ctx, 'Done');
const work = (title = 'Plex upgrade') => createCard(t.ctx, { title, kind: 'work' });

describe('work cards and "part of"', () => {
  it('files tickets under a work card and records it on both cards', () => {
    const w = work();
    const a = createCard(t.ctx, { title: 'Back up DB', parentId: w.id });
    const b = createCard(t.ctx, { title: 'Test HDR', columnId: columnId(t.ctx, 'Backlog'), parentId: w.id });

    expect(getCardTile(t.ctx, w.id)).toMatchObject({ kind: 'work', childCount: 2, childOpen: 2, parentId: null });
    expect(getCardTile(t.ctx, a.id)).toMatchObject({ kind: 'ticket', parentId: w.id });
    const detail = getCard(t.ctx, w.id);
    expect(detail.children.map((c) => c.title)).toEqual(['Back up DB', 'Test HDR']);
    expect(getCard(t.ctx, b.id).parent).toMatchObject({ id: w.id, kind: 'work', title: 'Plex upgrade' });

    expect(listActivity(t.ctx, a.id).find((e) => e.type === 'created')!.data).toMatchObject({ parent: { id: w.id, title: 'Plex upgrade' } });
    // History lists newest first.
    expect(listActivity(t.ctx, w.id).filter((e) => e.type === 'child_added').map((e) => e.data.child)).toMatchObject([
      { id: b.id, title: 'Test HDR' },
      { id: a.id, title: 'Back up DB' },
    ]);
  });

  it('moves tickets between work cards and out again, with history on all three', () => {
    const w1 = work('One');
    const w2 = work('Two');
    const a = createCard(t.ctx, { title: 'A', parentId: w1.id });
    updateCard(t.ctx, a.id, { parentId: w2.id });
    expect(listActivity(t.ctx, a.id).find((e) => e.type === 'parent_changed')!.data).toMatchObject({
      from: { id: w1.id },
      to: { id: w2.id },
    });
    expect(listActivity(t.ctx, w1.id).some((e) => e.type === 'child_removed')).toBe(true);
    expect(listActivity(t.ctx, w2.id).some((e) => e.type === 'child_added')).toBe(true);
    expect(updateCard(t.ctx, a.id, { parentId: null }).parent).toBeNull();
    expect(getCardTile(t.ctx, w2.id).childCount).toBe(0);
  });

  it('enforces the rules: work-card parents, one level, no work→ticket while it has tickets', () => {
    const w = work();
    const ticket = createCard(t.ctx, { title: 'Ticket' });
    const child = createCard(t.ctx, { title: 'Child', parentId: w.id });

    expect(failure(() => createCard(t.ctx, { title: 'X', parentId: ticket.id })).code).toBe('invalid_parent');
    expect(failure(() => createCard(t.ctx, { title: 'X', kind: 'work', parentId: w.id })).code).toBe('invalid_parent');
    expect(failure(() => updateCard(t.ctx, w.id, { parentId: w.id })).code).toBe('invalid_parent');
    expect(failure(() => updateCard(t.ctx, w.id, { kind: 'ticket' })).message).toMatch(/still has 1 ticket/);
    expect(failure(() => updateCard(t.ctx, child.id, { kind: 'work' })).message).toMatch(/out of its work card/);

    // Out of the work card and a work card itself in one change is fine.
    expect(updateCard(t.ctx, child.id, { kind: 'work', parentId: null })).toMatchObject({ kind: 'work', parent: null });
    expect(listActivity(t.ctx, child.id).some((e) => e.type === 'kind_changed')).toBe(true);
    expect(updateCard(t.ctx, w.id, { kind: 'ticket' }).kind).toBe('ticket');
  });

  it('a trashed or archived work card stops grouping; restoring it groups again', () => {
    const w = work();
    const a = createCard(t.ctx, { title: 'A', parentId: w.id });
    deleteCard(t.ctx, w.id);
    expect(getCardTile(t.ctx, a.id).parentId).toBeNull();
    expect(getCard(t.ctx, a.id).parent).toBeNull();
    undeleteCard(t.ctx, w.id);
    expect(getCardTile(t.ctx, a.id).parentId).toBe(w.id);

    moveCard(t.ctx, w.id, { toColumnId: done(), afterCardId: null });
    archiveCard(t.ctx, w.id);
    expect(getCardTile(t.ctx, a.id).parentId).toBeNull();
    expect(getCard(t.ctx, a.id).parent).toMatchObject({ id: w.id }); // still shown on the card
    restoreCard(t.ctx, w.id);
    expect(getCardTile(t.ctx, a.id).parentId).toBe(w.id);
  });

  it('the link picker can list only work cards', () => {
    work('Work A');
    createCard(t.ctx, { title: 'Ticket A' });
    expect(listCards(t.ctx, { status: 'live', kind: 'work', limit: 10 }).map((c) => c.title)).toEqual(['Work A']);
  });
});

describe('completing a work card', () => {
  it('only the card by default; with its tickets on request (already-done ones are skipped)', () => {
    const w = work();
    const a = createCard(t.ctx, { title: 'A', parentId: w.id });
    const b = createCard(t.ctx, { title: 'B', columnId: columnId(t.ctx, 'In Progress'), parentId: w.id });
    const c = createCard(t.ctx, { title: 'C', parentId: w.id });
    moveCard(t.ctx, c.id, { toColumnId: done(), afterCardId: null });
    const cCompleted = getCard(t.ctx, c.id).completedAt;
    t.clock.advance(60_000);

    const alone = completeCard(t.ctx, w.id, { includeChildren: false });
    expect(alone.completed).toEqual([w.id]);
    expect(getCard(t.ctx, a.id).completedAt).toBeNull();

    moveCard(t.ctx, w.id, { toColumnId: columnId(t.ctx, 'Backlog'), afterCardId: null }); // reopen
    const all = completeCard(t.ctx, w.id, { includeChildren: true });
    expect(all.completed.sort()).toEqual([a.id, b.id, w.id].sort());
    for (const id of [w.id, a.id, b.id]) expect(getCard(t.ctx, id).columnId).toBe(done());
    expect(getCard(t.ctx, c.id).completedAt).toBe(cCompleted);
    // The work card ends up on top of Done.
    expect(all.orders[String(done())]![0]).toBe(w.id);
    expect(all.card.childOpen).toBe(0);
  });

  it('is all or nothing when a ticket is blocked by a card outside the set', () => {
    setBlockedColumn(t.ctx, null);
    const w = work();
    const a = createCard(t.ctx, { title: 'A', parentId: w.id });
    const b = createCard(t.ctx, { title: 'B', parentId: w.id });
    const outside = createCard(t.ctx, { title: 'Outside' });
    createLink(t.ctx, b.id, outside.id, 'blocked_by');

    const err = failure(() => completeCard(t.ctx, w.id, { includeChildren: true }));
    expect(err.status).toBe(409);
    expect(err.code).toBe('blocked');
    expect(err.extra.stuck).toMatchObject([{ id: b.id, title: 'B', blockers: [{ id: outside.id }] }]);
    for (const id of [w.id, a.id, b.id]) expect(getCard(t.ctx, id).completedAt).toBeNull();
  });

  it('blockers inside the set count as finished', () => {
    setBlockedColumn(t.ctx, null);
    const w = work();
    const a = createCard(t.ctx, { title: 'A', parentId: w.id });
    const b = createCard(t.ctx, { title: 'B', parentId: w.id });
    createLink(t.ctx, b.id, a.id, 'blocked_by');
    createLink(t.ctx, w.id, b.id, 'blocked_by');
    expect(completeCard(t.ctx, w.id, { includeChildren: true }).completed).toHaveLength(3);
  });

  it('the board reports work cards and their open tickets', () => {
    const w = work();
    createCard(t.ctx, { title: 'A', parentId: w.id });
    const tile = getBoard(t.ctx).cards.find((c) => c.id === w.id)!;
    expect(tile).toMatchObject({ kind: 'work', childCount: 1, childOpen: 1 });
  });
});

describe('migration 4', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('turns existing cards into tickets with no parent', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'tt-mig4-'));
    const db = new Database(path.join(dir, 'tower.db'));
    migrate(db, { to: 3 });
    const now = '2026-10-10T15:00:00.000Z';
    db.prepare(`INSERT INTO columns (name, position, role, created_at) VALUES ('Triage', 0, 'triage', ?)`).run(now);
    db.prepare(`INSERT INTO cards (column_id, title, position, created_at, updated_at) VALUES (1, 'Old', 0, ?, ?)`).run(now, now);
    expect(migrate(db)).toEqual(MIGRATIONS.filter((m) => m.version > 3).map((m) => m.version));
    expect(db.prepare('SELECT kind, parent_id FROM cards').get()).toEqual({ kind: 'ticket', parent_id: null });
    db.close();
  });
});

describe('work cards over HTTP', () => {
  let app: TestApp;
  afterEach(() => app?.shutdown());

  it('creates, files and completes through the API', async () => {
    app = await makeApp();
    const c = client(app.app, await setupAndLogin(app));
    const w = (await c('POST', '/api/cards', { title: 'Work', kind: 'work' })).json();
    const a = (await c('POST', '/api/tickets', { title: 'Ticket', parentId: w.id, checklist: ['x'] })).json();
    expect(a).toMatchObject({ kind: 'ticket', parentId: w.id, parent: { id: w.id } });

    expect((await c('GET', '/api/cards?kind=work')).json().map((x: { id: number }) => x.id)).toEqual([w.id]);

    const res = await c('POST', `/api/cards/${w.id}/complete`, { includeChildren: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().completed.sort()).toEqual([w.id, a.id].sort());

    const bad = await c('PATCH', `/api/cards/${a.id}`, { expectedVersion: 99, parentId: a.id });
    expect([400, 409]).toContain(bad.statusCode);
  });

  it('needs auth and the CSRF header', async () => {
    app = await makeApp();
    await setupAndLogin(app);
    expect((await client(app.app)('POST', '/api/cards/1/complete', {})).statusCode).toBe(401);
    const noCsrf = await app.app.inject({ method: 'POST', url: '/api/cards/1/complete', payload: {} });
    expect(noCsrf.statusCode).toBe(403);
  });
});

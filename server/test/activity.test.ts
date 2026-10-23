import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listActivity } from '../src/services/activity';
import {
  archiveCard,
  createCard,
  deleteCard,
  moveCard,
  restoreCard,
  undeleteCard,
  updateCard,
} from '../src/services/cards';
import { deleteColumn, createColumn } from '../src/services/columns';
import { deleteLabel } from '../src/services/labels';
import { columnId, labelId, makeCtx } from './helpers';

let t: ReturnType<typeof makeCtx>;
beforeEach(() => {
  t = makeCtx();
});
afterEach(() => t.close());

const types = (cardId: number) => listActivity(t.ctx, cardId).map((e) => e.type).reverse();
const last = (cardId: number) => listActivity(t.ctx, cardId)[0]!;

describe('automatic activity events', () => {
  it('records created with the column name copied in', () => {
    const card = createCard(t.ctx, { title: 'Drive 3 throwing CRC errors' });
    const [created] = listActivity(t.ctx, card.id);
    expect(created).toMatchObject({
      kind: 'event',
      type: 'created',
      occurredAt: '2026-10-10T15:00:00.000Z',
      data: { column: { name: 'Triage', role: 'triage' }, title: 'Drive 3 throwing CRC errors', source: 'manual' },
    });
  });

  it('records one event per changed field and nothing for unchanged fields', () => {
    const card = createCard(t.ctx, { title: 'Old', description: 'a' });
    t.clock.advance(60_000);
    updateCard(t.ctx, card.id, {
      expectedVersion: card.version,
      title: 'New',
      description: 'b',
      priority: 'high',
      dueDate: '2026-10-12',
      dueTime: '18:00',
      labelIds: [labelId(t.ctx, 'Plex'), labelId(t.ctx, 'Docker')],
    });
    expect(types(card.id)).toEqual([
      'created',
      'title_changed',
      'description_changed',
      'priority_changed',
      'due_changed',
      'labels_changed',
    ]);
    const entries = listActivity(t.ctx, card.id);
    expect(entries.find((e) => e.type === 'title_changed')!.data).toEqual({ from: 'Old', to: 'New' });
    expect(entries.find((e) => e.type === 'description_changed')!.data).toEqual({ from: 'a', to: 'b' });
    expect(entries.find((e) => e.type === 'due_changed')!.data).toEqual({
      from: null,
      to: { date: '2026-10-12', time: '18:00' },
    });
    expect(entries.find((e) => e.type === 'labels_changed')!.data).toMatchObject({
      added: [{ name: 'Plex' }, { name: 'Docker' }],
      removed: [],
    });

    // Same values again: no new events, no version bump.
    const before = listActivity(t.ctx, card.id).length;
    const current = updateCard(t.ctx, card.id, { title: 'New', description: 'b', priority: 'high' });
    expect(listActivity(t.ctx, card.id).length).toBe(before);
    expect(current.version).toBe(card.version + 1);
  });

  it('records moves between columns with roles, but not reorders within a column', () => {
    const a = createCard(t.ctx, { title: 'A' });
    const b = createCard(t.ctx, { title: 'B' });
    moveCard(t.ctx, b.id, { toColumnId: a.columnId, afterCardId: null }); // reorder only
    expect(types(b.id)).toEqual(['created']);

    const done = columnId(t.ctx, 'Done');
    moveCard(t.ctx, b.id, { toColumnId: done, afterCardId: null });
    expect(last(b.id)).toMatchObject({
      type: 'moved',
      data: { from: { name: 'Triage', role: 'triage' }, to: { name: 'Done', role: 'done' } },
    });
  });

  it('logs label removal on every card when a label is deleted', () => {
    const plex = labelId(t.ctx, 'Plex');
    const a = createCard(t.ctx, { title: 'A', labelIds: [plex] });
    const b = createCard(t.ctx, { title: 'B', labelIds: [plex] });
    deleteLabel(t.ctx, plex);
    for (const id of [a.id, b.id]) {
      expect(last(id)).toMatchObject({
        type: 'labels_changed',
        data: { added: [], removed: [{ name: 'Plex' }], reason: 'label_deleted' },
      });
    }
  });

  it('logs a move for each live card when its column is deleted', () => {
    const col = createColumn(t.ctx, 'Parking lot');
    const a = createCard(t.ctx, { title: 'A', columnId: col.id });
    const b = createCard(t.ctx, { title: 'B', columnId: col.id });
    deleteCard(t.ctx, b.id);
    deleteColumn(t.ctx, col.id, columnId(t.ctx, 'Backlog'));
    expect(last(a.id)).toMatchObject({
      type: 'moved',
      data: { from: { name: 'Parking lot' }, to: { name: 'Backlog' }, reason: 'column_deleted' },
    });
    expect(last(b.id)).toMatchObject({ type: 'moved', data: { reason: 'column_deleted' } }); // trashed cards too
  });

  it('records trash, restore-from-trash, archive and restore', () => {
    const card = createCard(t.ctx, { title: 'A', columnId: columnId(t.ctx, 'Done') });
    deleteCard(t.ctx, card.id);
    undeleteCard(t.ctx, card.id);
    archiveCard(t.ctx, card.id);
    restoreCard(t.ctx, card.id);
    expect(types(card.id)).toEqual(['created', 'deleted', 'undeleted', 'archived', 'restored']);
  });

  it('keeps history in effective-time order, newest first', () => {
    const card = createCard(t.ctx, { title: 'A' });
    t.clock.advance(1000);
    updateCard(t.ctx, card.id, { title: 'B' });
    t.clock.advance(1000);
    updateCard(t.ctx, card.id, { title: 'C' });
    expect(listActivity(t.ctx, card.id).map((e) => e.type)).toEqual(['title_changed', 'title_changed', 'created']);
    expect(listActivity(t.ctx, card.id)[0]!.data).toEqual({ from: 'B', to: 'C' });
  });
});

describe('append-only guarantees (enforced by the database)', () => {
  function insertWorklog(cardId: number): number {
    const now = t.ctx.clock.now().toISOString();
    return Number(
      t.ctx.db
        .prepare(
          `INSERT INTO activity (card_id, kind, type, body_md, occurred_at, created_at)
           VALUES (?, 'worklog', 'worklog', 'Swapped SATA cable', ?, ?)`,
        )
        .run(cardId, now, now).lastInsertRowid,
    );
  }

  it('rejects deleting any activity row', () => {
    const card = createCard(t.ctx, { title: 'A' });
    expect(() => t.ctx.db.prepare('DELETE FROM activity WHERE card_id = ?').run(card.id)).toThrow(/append-only/);
    expect(() => t.ctx.db.exec('DELETE FROM activity')).toThrow(/append-only/);
  });

  it('rejects changing an automatic event', () => {
    const card = createCard(t.ctx, { title: 'A' });
    expect(() => t.ctx.db.prepare(`UPDATE activity SET data = '{}' WHERE card_id = ?`).run(card.id)).toThrow(
      /append-only/,
    );
    expect(() =>
      t.ctx.db.prepare(`UPDATE activity SET occurred_at = '2020-01-01T00:00:00.000Z' WHERE card_id = ?`).run(card.id),
    ).toThrow(/append-only/);
  });

  it('allows editing a work-log body/time/retraction but not moving it or changing its type', () => {
    const card = createCard(t.ctx, { title: 'A' });
    const other = createCard(t.ctx, { title: 'B' });
    const id = insertWorklog(card.id);
    const now = t.ctx.clock.now().toISOString();
    t.ctx.db
      .prepare('UPDATE activity SET body_md = ?, occurred_at = ?, edited_at = ?, retracted_at = ? WHERE id = ?')
      .run('Swapped SATA power cable', now, now, now, id);
    expect(() => t.ctx.db.prepare('UPDATE activity SET card_id = ? WHERE id = ?').run(other.id, id)).toThrow(
      /append-only/,
    );
    expect(() => t.ctx.db.prepare(`UPDATE activity SET created_at = ? WHERE id = ?`).run('2020-01-01T00:00:00.000Z', id)).toThrow(
      /append-only/,
    );
  });

  it('never allows revisions to be changed or deleted', () => {
    const card = createCard(t.ctx, { title: 'A' });
    const id = insertWorklog(card.id);
    const now = t.ctx.clock.now().toISOString();
    t.ctx.db
      .prepare('INSERT INTO activity_revisions (activity_id, body_md, occurred_at, revised_at) VALUES (?, ?, ?, ?)')
      .run(id, 'v1', now, now);
    expect(() => t.ctx.db.exec(`UPDATE activity_revisions SET body_md = 'x'`)).toThrow(/append-only/);
    expect(() => t.ctx.db.exec('DELETE FROM activity_revisions')).toThrow(/append-only/);
  });

  it('cards are never hard-deleted while they have history', () => {
    const card = createCard(t.ctx, { title: 'A' });
    expect(() => t.ctx.db.prepare('DELETE FROM cards WHERE id = ?').run(card.id)).toThrow(/FOREIGN KEY/);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/errors';
import {
  archiveCard,
  createCard,
  deleteCard,
  getBoard,
  getCard,
  moveCard,
  undeleteCard,
  updateCard,
} from '../src/services/cards';
import { reorderColumns } from '../src/services/columns';
import { columnId, labelId, makeCtx } from './helpers';

let t: ReturnType<typeof makeCtx>;
beforeEach(() => {
  t = makeCtx();
});
afterEach(() => t.close());

const order = (colName: string) =>
  getBoard(t.ctx)
    .cards.filter((c) => c.columnId === columnId(t.ctx, colName))
    .map((c) => c.title);

function errorOf(fn: () => unknown): AppError {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error('expected an AppError');
}

describe('createCard', () => {
  it('defaults to the bottom of Triage and supports top', () => {
    createCard(t.ctx, { title: 'A' });
    createCard(t.ctx, { title: 'B' });
    createCard(t.ctx, { title: 'C', position: 'top' });
    expect(order('Triage')).toEqual(['C', 'A', 'B']);
  });

  it('marks cards created directly in Done as completed', () => {
    const card = createCard(t.ctx, { title: 'Fixed already', columnId: columnId(t.ctx, 'Done') });
    expect(card.completedAt).toBe('2026-10-10T15:00:00.000Z');
  });

  it('resolves label names case-insensitively and creates unknown ones (v2 alert path)', () => {
    const card = createCard(t.ctx, { title: 'Alert', labelNames: ['plex', 'Grafana'] }, { source: 'api', sourceRef: 'alert:1' });
    expect(card.labelIds).toContain(labelId(t.ctx, 'Plex'));
    expect(card.labelIds).toContain(labelId(t.ctx, 'Grafana'));
    expect(card.source).toBe('api');
  });

  it('creates checklists and reports progress on the tile', () => {
    const card = createCard(t.ctx, {
      title: 'Parity',
      checklists: [{ title: 'Steps', items: ['one', 'two', 'three'] }],
    });
    expect(card.checklistTotal).toBe(3);
    expect(card.checklistDone).toBe(0);
  });

  it('rejects unknown label ids and a time without a date', () => {
    expect(errorOf(() => createCard(t.ctx, { title: 'x', labelIds: [999] })).code).toBe('validation');
    expect(errorOf(() => createCard(t.ctx, { title: 'x', dueTime: '10:00' })).code).toBe('validation');
  });
});

describe('moveCard', () => {
  it('places a card after an anchor card and renumbers both columns', () => {
    const [a, b, c] = ['A', 'B', 'C'].map((title) => createCard(t.ctx, { title }));
    const backlog = columnId(t.ctx, 'Backlog');
    const x = createCard(t.ctx, { title: 'X', columnId: backlog });
    const res = moveCard(t.ctx, b!.id, { toColumnId: backlog, afterCardId: x.id });
    expect(order('Triage')).toEqual(['A', 'C']);
    expect(order('Backlog')).toEqual(['X', 'B']);
    expect(res.orders).toEqual({
      [String(a!.columnId)]: [a!.id, c!.id],
      [String(backlog)]: [x.id, b!.id],
    });
  });

  it('null anchor = top; anchor = last card = bottom; within-column reorder', () => {
    const [a, b, c] = ['A', 'B', 'C'].map((title) => createCard(t.ctx, { title }));
    moveCard(t.ctx, c!.id, { toColumnId: c!.columnId, afterCardId: null });
    expect(order('Triage')).toEqual(['C', 'A', 'B']);
    moveCard(t.ctx, c!.id, { toColumnId: c!.columnId, afterCardId: b!.id });
    expect(order('Triage')).toEqual(['A', 'B', 'C']);
    moveCard(t.ctx, a!.id, { toColumnId: a!.columnId, afterCardId: b!.id });
    expect(order('Triage')).toEqual(['B', 'A', 'C']);
  });

  it('is correct when hidden (archived/trashed) cards share the column', () => {
    const done = columnId(t.ctx, 'Done');
    const [a, hidden, b] = ['A', 'Hidden', 'B'].map((title) => createCard(t.ctx, { title, columnId: done }));
    archiveCard(t.ctx, hidden!.id);
    const n = createCard(t.ctx, { title: 'N' });
    moveCard(t.ctx, n.id, { toColumnId: done, afterCardId: a!.id });
    expect(order('Done')).toEqual(['A', 'N', 'B']);
    expect(b).toBeDefined();
  });

  it('rejects an anchor that is not visible in the target column', () => {
    const a = createCard(t.ctx, { title: 'A' });
    const b = createCard(t.ctx, { title: 'B', columnId: columnId(t.ctx, 'Backlog') });
    expect(errorOf(() => moveCard(t.ctx, a.id, { toColumnId: a.columnId, afterCardId: b.id })).code).toBe(
      'anchor_not_found',
    );
    // Anchoring a card on itself in its own column is a no-op ("Bottom" on the last card).
    expect(moveCard(t.ctx, a.id, { toColumnId: a.columnId, afterCardId: a.id }).orders).toEqual({
      [String(a.columnId)]: [a.id],
    });
  });

  it('sets completedAt entering Done and clears it leaving', () => {
    const a = createCard(t.ctx, { title: 'A' });
    t.clock.advance(3_600_000);
    moveCard(t.ctx, a.id, { toColumnId: columnId(t.ctx, 'Done'), afterCardId: null });
    expect(getCard(t.ctx, a.id).completedAt).toBe('2026-10-10T16:00:00.000Z');
    moveCard(t.ctx, a.id, { toColumnId: columnId(t.ctx, 'In Progress'), afterCardId: null });
    expect(getCard(t.ctx, a.id).completedAt).toBeNull();
  });

  it('follows the Done role even after the column is renamed and reordered', () => {
    const done = columnId(t.ctx, 'Done');
    t.ctx.db.prepare('UPDATE columns SET name = ? WHERE id = ?').run('Closed', done);
    const ids = getBoard(t.ctx).columns.map((c) => c.id).reverse();
    reorderColumns(t.ctx, ids);
    const a = createCard(t.ctx, { title: 'A' });
    moveCard(t.ctx, a.id, { toColumnId: done, afterCardId: null });
    expect(getCard(t.ctx, a.id).completedAt).not.toBeNull();
  });

  it('refuses to move trashed or archived cards', () => {
    const a = createCard(t.ctx, { title: 'A', columnId: columnId(t.ctx, 'Done') });
    archiveCard(t.ctx, a.id);
    expect(errorOf(() => moveCard(t.ctx, a.id, { toColumnId: a.columnId, afterCardId: null })).code).toBe(
      'card_archived',
    );
    const b = createCard(t.ctx, { title: 'B' });
    deleteCard(t.ctx, b.id);
    expect(errorOf(() => moveCard(t.ctx, b.id, { toColumnId: b.columnId, afterCardId: null })).code).toBe(
      'card_deleted',
    );
  });
});

describe('updateCard', () => {
  it('detects edits from another device via the version', () => {
    const card = createCard(t.ctx, { title: 'A' });
    updateCard(t.ctx, card.id, { expectedVersion: card.version, title: 'From phone' });
    const err = errorOf(() => updateCard(t.ctx, card.id, { expectedVersion: card.version, title: 'From desktop' }));
    expect(err.code).toBe('version_conflict');
    expect((err.extra.card as { title: string }).title).toBe('From phone');
  });

  it('clears the time when the due date is cleared', () => {
    const card = createCard(t.ctx, { title: 'A', dueDate: '2026-10-11', dueTime: '09:30' });
    const updated = updateCard(t.ctx, card.id, { dueDate: null });
    expect(updated.dueDate).toBeNull();
    expect(updated.dueTime).toBeNull();
  });

  it('does not allow editing a trashed card', () => {
    const card = createCard(t.ctx, { title: 'A' });
    deleteCard(t.ctx, card.id);
    expect(errorOf(() => updateCard(t.ctx, card.id, { title: 'B' })).code).toBe('card_deleted');
  });
});

describe('trash and archive', () => {
  it('hides trashed and archived cards from the board but keeps them readable', () => {
    const a = createCard(t.ctx, { title: 'A' });
    const b = createCard(t.ctx, { title: 'B', columnId: columnId(t.ctx, 'Done') });
    deleteCard(t.ctx, a.id);
    archiveCard(t.ctx, b.id);
    expect(getBoard(t.ctx).cards).toHaveLength(0);
    expect(getCard(t.ctx, a.id).deletedAt).not.toBeNull();
    expect(getCard(t.ctx, b.id).archivedAt).not.toBeNull();
  });

  it('only archives cards in Done', () => {
    const a = createCard(t.ctx, { title: 'A' });
    expect(errorOf(() => archiveCard(t.ctx, a.id)).code).toBe('not_done');
  });

  it('restores from trash to the bottom of its column', () => {
    const a = createCard(t.ctx, { title: 'A' });
    createCard(t.ctx, { title: 'B' });
    deleteCard(t.ctx, a.id);
    createCard(t.ctx, { title: 'C' });
    undeleteCard(t.ctx, a.id);
    expect(order('Triage')).toEqual(['B', 'C', 'A']);
  });
});

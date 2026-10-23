import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/errors';
import { createCard, deleteCard, getBoard, getCard } from '../src/services/cards';
import { createColumn, deleteColumn, listColumns, renameColumn, reorderColumns } from '../src/services/columns';
import { createLabel, deleteLabel, listLabels, reorderLabels, updateLabel } from '../src/services/labels';
import { columnId, labelId, makeCtx } from './helpers';

let t: ReturnType<typeof makeCtx>;
beforeEach(() => {
  t = makeCtx();
});
afterEach(() => t.close());

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
  return 'no error';
}

describe('seed', () => {
  it('creates the five default columns with Triage/Done roles and the eight labels', () => {
    expect(listColumns(t.ctx).map((c) => [c.name, c.role])).toEqual([
      ['Triage', 'triage'],
      ['Backlog', null],
      ['In Progress', null],
      ['Blocked/Waiting', null],
      ['Done', 'done'],
    ]);
    expect(listLabels(t.ctx).map((l) => l.name)).toEqual([
      'Plex',
      'Array/Storage',
      'Network',
      'NPM/Proxy',
      'VMs',
      'Docker',
      'Hardware',
      'Unraid OS',
    ]);
  });

  it('seeds the three maintenance templates disabled', () => {
    const rows = t.ctx.db.prepare('SELECT title, enabled, interval_unit, start_date FROM recurring_templates').all();
    expect(rows).toEqual([
      { title: 'Monthly parity check', enabled: 0, interval_unit: 'month', start_date: '2026-11-01' },
      { title: 'Monthly SMART review', enabled: 0, interval_unit: 'month', start_date: '2026-11-15' },
      { title: 'Weekly container & plugin update check', enabled: 0, interval_unit: 'week', start_date: '2026-10-11' },
    ]);
  });
});

describe('columns', () => {
  it('adds at the end, renames and reorders', () => {
    const col = createColumn(t.ctx, 'Ideas');
    expect(listColumns(t.ctx).at(-1)!.name).toBe('Ideas');
    renameColumn(t.ctx, col.id, 'Someday');
    const ids = listColumns(t.ctx).map((c) => c.id);
    reorderColumns(t.ctx, [col.id, ...ids.filter((id) => id !== col.id)]);
    expect(listColumns(t.ctx).map((c) => c.name)[0]).toBe('Someday');
  });

  it('requires a full permutation to reorder', () => {
    const ids = listColumns(t.ctx).map((c) => c.id);
    expect(code(() => reorderColumns(t.ctx, ids.slice(1)))).toBe('validation');
    expect(code(() => reorderColumns(t.ctx, [...ids.slice(1), ids[1]!]))).toBe('validation');
  });

  it('never deletes the Triage or Done column', () => {
    expect(code(() => deleteColumn(t.ctx, columnId(t.ctx, 'Triage')))).toBe('role_column');
    expect(code(() => deleteColumn(t.ctx, columnId(t.ctx, 'Done')))).toBe('role_column');
  });

  it('enforces one column per role in the database', () => {
    expect(() =>
      t.ctx.db
        .prepare(`INSERT INTO columns (name, position, role, created_at) VALUES ('Done 2', 9, 'done', ?)`)
        .run('2026-10-10T15:00:00.000Z'),
    ).toThrow(/UNIQUE/);
  });

  it('needs a target when the column holds any card (even a trashed one) and moves them all', () => {
    const backlog = columnId(t.ctx, 'Backlog');
    const a = createCard(t.ctx, { title: 'A', columnId: backlog });
    const b = createCard(t.ctx, { title: 'B', columnId: backlog });
    deleteCard(t.ctx, b.id);
    expect(code(() => deleteColumn(t.ctx, backlog))).toBe('target_required');
    expect(code(() => deleteColumn(t.ctx, backlog, backlog))).toBe('invalid_target');
    deleteColumn(t.ctx, backlog, columnId(t.ctx, 'Done'));
    expect(getCard(t.ctx, a.id).columnId).toBe(columnId(t.ctx, 'Done'));
    expect(getCard(t.ctx, a.id).completedAt).not.toBeNull();
    expect(getCard(t.ctx, b.id).columnId).toBe(columnId(t.ctx, 'Done'));
    expect(listColumns(t.ctx).map((c) => c.position)).toEqual([0, 1, 2, 3]);
  });

  it('deletes an empty column without a target', () => {
    const col = createColumn(t.ctx, 'Temp');
    deleteColumn(t.ctx, col.id);
    expect(listColumns(t.ctx).some((c) => c.id === col.id)).toBe(false);
  });
});

describe('labels', () => {
  it('rejects duplicate names case-insensitively', () => {
    expect(code(() => createLabel(t.ctx, 'plex', '#579dff'))).toBe('duplicate_name');
    expect(code(() => updateLabel(t.ctx, labelId(t.ctx, 'Docker'), { name: 'PLEX' }))).toBe('duplicate_name');
  });

  it('renames/recolors and the change shows on cards immediately', () => {
    const plex = labelId(t.ctx, 'Plex');
    createCard(t.ctx, { title: 'A', labelIds: [plex] });
    updateLabel(t.ctx, plex, { name: 'Plex Media Server', color: '#fea362' });
    const board = getBoard(t.ctx);
    expect(board.labels.find((l) => l.id === plex)).toMatchObject({ name: 'Plex Media Server', color: '#fea362' });
    expect(board.cards[0]!.labelIds).toEqual([plex]);
  });

  it('removes a deleted label from cards and bumps their version', () => {
    const plex = labelId(t.ctx, 'Plex');
    const card = createCard(t.ctx, { title: 'A', labelIds: [plex] });
    deleteLabel(t.ctx, plex);
    const after = getCard(t.ctx, card.id);
    expect(after.labelIds).toEqual([]);
    expect(after.version).toBe(card.version + 1);
    expect(listLabels(t.ctx).map((l) => l.position)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('reorders labels and orders card label ids by label position', () => {
    const ids = listLabels(t.ctx).map((l) => l.id);
    const card = createCard(t.ctx, { title: 'A', labelIds: [ids[0]!, ids[1]!] });
    reorderLabels(t.ctx, [...ids].reverse());
    expect(getCard(t.ctx, card.id).labelIds).toEqual([ids[1], ids[0]]);
  });
});

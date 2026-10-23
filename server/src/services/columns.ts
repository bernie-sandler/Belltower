import type { Column, ColumnRole } from '@tt/shared';
import { stmt } from '../db/connection';
import { AppError, badRequest, conflict, notFound } from '../errors';
import { columnRef, recordEvent } from './activity';
import { nowIso, tx, type Ctx } from './context';

export interface ColumnRow {
  id: number;
  name: string;
  position: number;
  role: ColumnRole | null;
  created_at: string;
}

export function toColumn(row: ColumnRow): Column {
  return { id: row.id, name: row.name, position: row.position, role: row.role };
}

export function listColumns(ctx: Ctx): Column[] {
  return (stmt(ctx.db, 'SELECT * FROM columns ORDER BY position, id').all() as ColumnRow[]).map(toColumn);
}

export function getColumnRow(ctx: Ctx, id: number): ColumnRow {
  const row = stmt(ctx.db, 'SELECT * FROM columns WHERE id = ?').get(id) as ColumnRow | undefined;
  if (!row) throw notFound('Column not found');
  return row;
}

export function getRoleColumn(ctx: Ctx, role: ColumnRole): ColumnRow {
  const row = stmt(ctx.db, 'SELECT * FROM columns WHERE role = ?').get(role) as ColumnRow | undefined;
  if (!row) throw new AppError(500, 'internal', `The ${role} column is missing`);
  return row;
}

export function createColumn(ctx: Ctx, name: string): Column {
  return tx(ctx, () => {
    const pos = stmt(ctx.db, 'SELECT coalesce(max(position), -1) + 1 FROM columns').pluck().get() as number;
    const info = stmt(ctx.db, 'INSERT INTO columns (name, position, role, created_at) VALUES (?, ?, NULL, ?)').run(
      name,
      pos,
      nowIso(ctx),
    );
    return toColumn(getColumnRow(ctx, Number(info.lastInsertRowid)));
  });
}

export function renameColumn(ctx: Ctx, id: number, name: string): Column {
  return tx(ctx, () => {
    getColumnRow(ctx, id);
    stmt(ctx.db, 'UPDATE columns SET name = ? WHERE id = ?').run(name, id);
    return toColumn(getColumnRow(ctx, id));
  });
}

function renumberColumns(ctx: Ctx, orderedIds: number[]): void {
  const update = stmt(ctx.db, 'UPDATE columns SET position = ? WHERE id = ?');
  orderedIds.forEach((id, i) => update.run(i, id));
}

/** `ids` must list every column exactly once, in the new left-to-right order. */
export function reorderColumns(ctx: Ctx, ids: number[]): Column[] {
  return tx(ctx, () => {
    const existing = stmt(ctx.db, 'SELECT id FROM columns ORDER BY id').pluck().all() as number[];
    const given = [...ids].sort((a, b) => a - b);
    if (given.length !== existing.length || given.some((id, i) => id !== existing[i])) {
      throw badRequest('validation', 'ids must contain every column id exactly once');
    }
    renumberColumns(ctx, ids);
    return listColumns(ctx);
  });
}

/**
 * Deletes a column. Triage/Done columns can't be deleted. Any cards in it (including archived and
 * trashed ones, which still reference the column) move to the bottom of `targetColumnId`, and each
 * card logs a `moved` event.
 */
export function deleteColumn(ctx: Ctx, id: number, targetColumnId?: number): void {
  tx(ctx, () => {
    const col = getColumnRow(ctx, id);
    if (col.role) {
      throw conflict('role_column', `The ${col.role === 'done' ? 'Done' : 'Triage'} column can't be deleted`);
    }
    const cards = stmt(
      ctx.db,
      `SELECT id, deleted_at, archived_at, completed_at FROM cards WHERE column_id = ?
        ORDER BY (deleted_at IS NOT NULL), (archived_at IS NOT NULL), position, id`,
    ).all(id) as { id: number; deleted_at: string | null; archived_at: string | null; completed_at: string | null }[];

    if (cards.length) {
      if (targetColumnId === undefined) {
        throw badRequest('target_required', 'This column has cards; choose a column to move them to');
      }
      if (targetColumnId === id) throw badRequest('invalid_target', 'Target column must be a different column');
      const target = stmt(ctx.db, 'SELECT * FROM columns WHERE id = ?').get(targetColumnId) as ColumnRow | undefined;
      if (!target) throw badRequest('invalid_target', 'Target column not found');

      const now = nowIso(ctx);
      let pos = stmt(ctx.db, 'SELECT coalesce(max(position), -1) + 1 FROM cards WHERE column_id = ?')
        .pluck()
        .get(target.id) as number;
      const move = stmt(
        ctx.db,
        'UPDATE cards SET column_id = ?, position = ?, completed_at = ?, updated_at = ? WHERE id = ?',
      );
      for (const card of cards) {
        const completedAt = target.role === 'done' ? (card.completed_at ?? now) : card.completed_at;
        move.run(target.id, pos++, completedAt, now, card.id);
        recordEvent(ctx, card.id, 'moved', { from: columnRef(col), to: columnRef(target), reason: 'column_deleted' });
      }
    }
    stmt(ctx.db, 'DELETE FROM columns WHERE id = ?').run(id);
    renumberColumns(ctx, stmt(ctx.db, 'SELECT id FROM columns ORDER BY position, id').pluck().all() as number[]);
  });
}

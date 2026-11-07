// Mirrors server/src/services/columns.ts.

import type { Column, ColumnRole } from '@tt/shared';
import { columnRef, recordEvent } from './activity';
import { assertNotBlocked } from './cardParts';
import { byPosition, nextId, nowIso, type ColumnRow, type Ctx } from './db';
import { badRequest, conflict, DemoError, notFound } from './errors';

export const toColumn = (row: ColumnRow): Column => ({ id: row.id, name: row.name, position: row.position, role: row.role });

export function listColumns(ctx: Ctx): Column[] {
  return [...ctx.s.columns].sort(byPosition).map(toColumn);
}

export function findColumn(ctx: Ctx, id: number): ColumnRow | undefined {
  return ctx.s.columns.find((c) => c.id === id);
}

export function getColumnRow(ctx: Ctx, id: number): ColumnRow {
  const row = findColumn(ctx, id);
  if (!row) throw notFound('Column not found');
  return row;
}

export function getRoleColumn(ctx: Ctx, role: ColumnRole): ColumnRow {
  const row = ctx.s.columns.find((c) => c.role === role);
  if (!row) throw new DemoError(500, 'internal', `The ${role} column is missing`);
  return row;
}

export function createColumn(ctx: Ctx, name: string): Column {
  const pos = Math.max(-1, ...ctx.s.columns.map((c) => c.position)) + 1;
  const row: ColumnRow = { id: nextId(ctx, 'columns'), name, position: pos, role: null, createdAt: nowIso(ctx) };
  ctx.s.columns.push(row);
  return toColumn(row);
}

export function renameColumn(ctx: Ctx, id: number, name: string): Column {
  const row = getColumnRow(ctx, id);
  row.name = name;
  return toColumn(row);
}

function renumberColumns(ctx: Ctx, orderedIds: number[]): void {
  orderedIds.forEach((id, i) => {
    const c = findColumn(ctx, id);
    if (c) c.position = i;
  });
}

/** `ids` must list every column exactly once, in the new left-to-right order. */
export function reorderColumns(ctx: Ctx, ids: number[]): Column[] {
  const existing = ctx.s.columns.map((c) => c.id).sort((a, b) => a - b);
  const given = [...ids].sort((a, b) => a - b);
  if (given.length !== existing.length || given.some((id, i) => id !== existing[i])) {
    throw badRequest('validation', 'ids must contain every column id exactly once');
  }
  renumberColumns(ctx, ids);
  return listColumns(ctx);
}

/**
 * The column cards are moved into when they become blocked, or null when that's turned off. The
 * first time, it picks the left-most column named like "Blocked" or "Waiting".
 */
export function getBlockedColumnId(ctx: Ctx): number | null {
  let value = ctx.s.settings.blockedColumn;
  if (value === null) {
    const found = [...ctx.s.columns]
      .sort(byPosition)
      .find((c) => c.role === null && /block|wait/i.test(c.name));
    value = found ? found.id : 'none';
    ctx.s.settings.blockedColumn = value;
  }
  if (value === 'none') return null;
  return findColumn(ctx, value) ? value : null;
}

/** Chooses the blocked column (null turns automatic moving off). Triage and Done can't be it. */
export function setBlockedColumn(ctx: Ctx, columnId: number | null): void {
  if (columnId !== null) {
    const col = findColumn(ctx, columnId);
    if (!col) throw notFound('Column not found');
    if (col.role) {
      throw badRequest('invalid_target', `Blocked cards can't be sent to the ${col.role === 'done' ? 'Done' : 'Triage'} column`);
    }
  }
  ctx.s.settings.blockedColumn = columnId === null ? 'none' : columnId;
}

export function deleteColumn(ctx: Ctx, id: number, targetColumnId?: number): void {
  const col = getColumnRow(ctx, id);
  if (col.role) {
    throw conflict('role_column', `The ${col.role === 'done' ? 'Done' : 'Triage'} column can't be deleted`);
  }
  const rank = (v: string | null) => (v === null ? 0 : 1);
  const cards = ctx.s.cards
    .filter((c) => c.columnId === id)
    .sort((a, b) => rank(a.deletedAt) - rank(b.deletedAt) || rank(a.archivedAt) - rank(b.archivedAt) || byPosition(a, b));

  if (cards.length) {
    if (targetColumnId === undefined) {
      throw badRequest('target_required', 'This column has cards; choose a column to move them to');
    }
    if (targetColumnId === id) throw badRequest('invalid_target', 'Target column must be a different column');
    const target = findColumn(ctx, targetColumnId);
    if (!target) throw badRequest('invalid_target', 'Target column not found');

    if (target.role === 'done') {
      for (const card of cards) {
        if (!card.completedAt && !card.deletedAt) assertNotBlocked(ctx, card);
      }
    }

    const now = nowIso(ctx);
    let pos = Math.max(-1, ...ctx.s.cards.filter((c) => c.columnId === target.id).map((c) => c.position)) + 1;
    for (const card of cards) {
      card.columnId = target.id;
      card.position = pos++;
      if (target.role === 'done') card.completedAt = card.completedAt ?? now;
      card.updatedAt = now;
      recordEvent(ctx, card.id, 'moved', { from: columnRef(col), to: columnRef(target), reason: 'column_deleted' });
    }
  }
  ctx.s.columns = ctx.s.columns.filter((c) => c.id !== id);
  if (ctx.s.settings.blockedColumn === id) ctx.s.settings.blockedColumn = 'none';
  renumberColumns(ctx, [...ctx.s.columns].sort(byPosition).map((c) => c.id));
}

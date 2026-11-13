import { LABEL_COLORS, type Label } from '@tt/shared';
import { stmt } from '../db/connection';
import { badRequest, conflict, notFound } from '../errors';
import { labelRef, recordEvent } from './activity';
import { nowIso, tx, type Ctx } from './context';
import { assertUnrestricted } from './scope';

export interface LabelRow {
  id: number;
  name: string;
  color: string;
  position: number;
  created_at: string;
}

export function toLabel(row: LabelRow): Label {
  return { id: row.id, name: row.name, color: row.color, position: row.position };
}

export function listLabels(ctx: Ctx): Label[] {
  return (stmt(ctx.db, 'SELECT * FROM labels ORDER BY position, id').all() as LabelRow[]).map(toLabel);
}

export function getLabelRow(ctx: Ctx, id: number): LabelRow {
  const row = stmt(ctx.db, 'SELECT * FROM labels WHERE id = ?').get(id) as LabelRow | undefined;
  if (!row) throw notFound('Label not found');
  return row;
}

function assertNameFree(ctx: Ctx, name: string, exceptId?: number): void {
  const clash = stmt(ctx.db, 'SELECT id FROM labels WHERE name = ? COLLATE NOCASE').pluck().get(name) as
    | number
    | undefined;
  if (clash !== undefined && clash !== exceptId) throw conflict('duplicate_name', `A label named "${name}" already exists`);
}

export function createLabel(ctx: Ctx, name: string, color: string): Label {
  // Tags decide who sees what, so tag-restricted people can't change them.
  assertUnrestricted(ctx, 'add tags');
  return tx(ctx, () => {
    assertNameFree(ctx, name);
    const pos = stmt(ctx.db, 'SELECT coalesce(max(position), -1) + 1 FROM labels').pluck().get() as number;
    const info = stmt(ctx.db, 'INSERT INTO labels (name, color, position, created_at) VALUES (?, ?, ?, ?)').run(
      name,
      color,
      pos,
      nowIso(ctx),
    );
    return toLabel(getLabelRow(ctx, Number(info.lastInsertRowid)));
  });
}

export function updateLabel(ctx: Ctx, id: number, patch: { name?: string; color?: string }): Label {
  assertUnrestricted(ctx, 'change tags');
  return tx(ctx, () => {
    const row = getLabelRow(ctx, id);
    if (patch.name !== undefined && patch.name !== row.name) assertNameFree(ctx, patch.name, id);
    stmt(ctx.db, 'UPDATE labels SET name = ?, color = ? WHERE id = ?').run(
      patch.name ?? row.name,
      patch.color ?? row.color,
      id,
    );
    return toLabel(getLabelRow(ctx, id));
  });
}

/**
 * Removes the label everywhere; every affected card (including ones in the Trash, so a restored card's
 * history explains the missing label) records the removal in its log.
 */
export function deleteLabel(ctx: Ctx, id: number): void {
  assertUnrestricted(ctx, 'delete tags');
  tx(ctx, () => {
    const row = getLabelRow(ctx, id);
    const cardIds = stmt(ctx.db, 'SELECT card_id FROM card_labels WHERE label_id = ? ORDER BY card_id')
      .pluck()
      .all(id) as number[];
    const now = nowIso(ctx);
    for (const cardId of cardIds) {
      recordEvent(ctx, cardId, 'labels_changed', { added: [], removed: [labelRef(row)], reason: 'label_deleted' });
      stmt(ctx.db, 'UPDATE cards SET version = version + 1, updated_at = ? WHERE id = ?').run(now, cardId);
    }
    stmt(ctx.db, 'DELETE FROM labels WHERE id = ?').run(id);
    const ids = stmt(ctx.db, 'SELECT id FROM labels ORDER BY position, id').pluck().all() as number[];
    const update = stmt(ctx.db, 'UPDATE labels SET position = ? WHERE id = ?');
    ids.forEach((lid, i) => update.run(i, lid));
  });
}

export function reorderLabels(ctx: Ctx, ids: number[]): Label[] {
  assertUnrestricted(ctx, 'reorder tags');
  return tx(ctx, () => {
    const existing = stmt(ctx.db, 'SELECT id FROM labels ORDER BY id').pluck().all() as number[];
    const given = [...ids].sort((a, b) => a - b);
    if (given.length !== existing.length || given.some((lid, i) => lid !== existing[i])) {
      throw badRequest('validation', 'ids must contain every label id exactly once');
    }
    const update = stmt(ctx.db, 'UPDATE labels SET position = ? WHERE id = ?');
    ids.forEach((lid, i) => update.run(i, lid));
    return listLabels(ctx);
  });
}

/**
 * Resolves label ids and names to rows. Unknown ids are an error; unknown names are created
 * (used by recurring templates now and the v2 alert endpoint later).
 */
export function resolveLabels(ctx: Ctx, ids: number[] = [], names: string[] = []): LabelRow[] {
  const out = new Map<number, LabelRow>();
  for (const id of ids) {
    const row = stmt(ctx.db, 'SELECT * FROM labels WHERE id = ?').get(id) as LabelRow | undefined;
    if (!row) throw badRequest('validation', `Unknown label id ${id}`);
    out.set(row.id, row);
  }
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    let row = stmt(ctx.db, 'SELECT * FROM labels WHERE name = ? COLLATE NOCASE').get(name) as LabelRow | undefined;
    if (!row) {
      const count = stmt(ctx.db, 'SELECT count(*) FROM labels').pluck().get() as number;
      const color = LABEL_COLORS[count % LABEL_COLORS.length]!.hex;
      const created = createLabel(ctx, name.slice(0, 40), color);
      row = getLabelRow(ctx, created.id);
    }
    out.set(row.id, row);
  }
  return [...out.values()];
}

// Mirrors server/src/services/labels.ts.

import { LABEL_COLORS, type Label } from '@tt/shared';
import { labelRef, recordEvent } from './activity';
import { byPosition, nextId, nowIso, type Ctx, type LabelRow } from './db';
import { badRequest, conflict, notFound } from './errors';

export const toLabel = (row: LabelRow): Label => ({ id: row.id, name: row.name, color: row.color, position: row.position });

export function listLabels(ctx: Ctx): Label[] {
  return [...ctx.s.labels].sort(byPosition).map(toLabel);
}

export function getLabelRow(ctx: Ctx, id: number): LabelRow {
  const row = ctx.s.labels.find((l) => l.id === id);
  if (!row) throw notFound('Label not found');
  return row;
}

const findByName = (ctx: Ctx, name: string) => ctx.s.labels.find((l) => l.name.toLowerCase() === name.toLowerCase());

function assertNameFree(ctx: Ctx, name: string, exceptId?: number): void {
  const clash = findByName(ctx, name);
  if (clash && clash.id !== exceptId) throw conflict('duplicate_name', `A label named "${name}" already exists`);
}

export function createLabel(ctx: Ctx, name: string, color: string): Label {
  assertNameFree(ctx, name);
  const pos = Math.max(-1, ...ctx.s.labels.map((l) => l.position)) + 1;
  const row: LabelRow = { id: nextId(ctx, 'labels'), name, color, position: pos, createdAt: nowIso(ctx) };
  ctx.s.labels.push(row);
  return toLabel(row);
}

export function updateLabel(ctx: Ctx, id: number, patch: { name?: string; color?: string }): Label {
  const row = getLabelRow(ctx, id);
  if (patch.name !== undefined && patch.name !== row.name) assertNameFree(ctx, patch.name, id);
  row.name = patch.name ?? row.name;
  row.color = patch.color ?? row.color;
  return toLabel(row);
}

/** Removes the label everywhere; every affected card (Trash included) records the removal. */
export function deleteLabel(ctx: Ctx, id: number): void {
  const row = getLabelRow(ctx, id);
  const now = nowIso(ctx);
  for (const card of [...ctx.s.cards].sort((a, b) => a.id - b.id)) {
    if (!card.labelIds.includes(id)) continue;
    recordEvent(ctx, card.id, 'labels_changed', { added: [], removed: [labelRef(row)], reason: 'label_deleted' });
    card.labelIds = card.labelIds.filter((l) => l !== id);
    card.version += 1;
    card.updatedAt = now;
  }
  for (const t of ctx.s.templates) t.labelIds = t.labelIds.filter((l) => l !== id);
  ctx.s.labels = ctx.s.labels.filter((l) => l.id !== id);
  [...ctx.s.labels].sort(byPosition).forEach((l, i) => (l.position = i));
}

export function reorderLabels(ctx: Ctx, ids: number[]): Label[] {
  const existing = ctx.s.labels.map((l) => l.id).sort((a, b) => a - b);
  const given = [...ids].sort((a, b) => a - b);
  if (given.length !== existing.length || given.some((lid, i) => lid !== existing[i])) {
    throw badRequest('validation', 'ids must contain every label id exactly once');
  }
  ids.forEach((lid, i) => (getLabelRow(ctx, lid).position = i));
  return listLabels(ctx);
}

/** Label ids and names to rows. Unknown ids are an error; unknown names are created. */
export function resolveLabels(ctx: Ctx, ids: number[] = [], names: string[] = []): LabelRow[] {
  const out = new Map<number, LabelRow>();
  for (const id of ids) {
    const row = ctx.s.labels.find((l) => l.id === id);
    if (!row) throw badRequest('validation', `Unknown label id ${id}`);
    out.set(row.id, row);
  }
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    let row = findByName(ctx, name);
    if (!row) {
      const color = LABEL_COLORS[ctx.s.labels.length % LABEL_COLORS.length]!.hex;
      row = getLabelRow(ctx, createLabel(ctx, name.slice(0, 40), color).id);
    }
    out.set(row.id, row);
  }
  return [...out.values()];
}

/** A card's label ids in label order (position, id), like the server's group_concat. */
export function labelIdsOf(ctx: Ctx, ids: number[]): number[] {
  return ctx.s.labels
    .filter((l) => ids.includes(l.id))
    .sort(byPosition)
    .map((l) => l.id);
}

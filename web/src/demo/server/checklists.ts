// Mirrors server/src/services/checklists.ts. Every change returns the full card.

import type { CardDetail } from '@tt/shared';
import { recordEvent } from './activity';
import { getCard, getEditableCard, touchCard } from './cards';
import { byPosition, nextId, nowIso, type ChecklistItemRow, type ChecklistRow, type Ctx } from './db';
import { badRequest, notFound } from './errors';

function checklistRow(ctx: Ctx, id: number): ChecklistRow {
  const row = ctx.s.checklists.find((l) => l.id === id);
  if (!row) throw notFound('Checklist not found');
  return row;
}

function itemRow(ctx: Ctx, id: number): ChecklistItemRow {
  const row = ctx.s.checklistItems.find((i) => i.id === id);
  if (!row) throw notFound('Checklist item not found');
  return row;
}

function changed(ctx: Ctx, cardId: number): CardDetail {
  touchCard(ctx, cardId);
  return getCard(ctx, cardId);
}

/** Ids must be exactly the current set, in the new order. */
function reorder<T extends { id: number; position: number }>(rows: T[], ids: number[]): void {
  const a = rows.map((r) => r.id).sort((x, y) => x - y);
  const b = [...ids].sort((x, y) => x - y);
  if (a.length !== b.length || a.some((v, i) => v !== b[i])) {
    throw badRequest('validation', 'ids must contain every item exactly once');
  }
  ids.forEach((id, i) => (rows.find((r) => r.id === id)!.position = i));
}

const listsOf = (ctx: Ctx, cardId: number) => ctx.s.checklists.filter((l) => l.cardId === cardId);
const itemsOf = (ctx: Ctx, listId: number) => ctx.s.checklistItems.filter((i) => i.checklistId === listId);

export function addChecklist(ctx: Ctx, cardId: number, title: string): CardDetail {
  getEditableCard(ctx, cardId);
  const pos = Math.max(-1, ...listsOf(ctx, cardId).map((l) => l.position)) + 1;
  const id = nextId(ctx, 'checklists');
  ctx.s.checklists.push({ id, cardId, title, position: pos, createdAt: nowIso(ctx) });
  recordEvent(ctx, cardId, 'checklist_added', { checklistId: id, title });
  return changed(ctx, cardId);
}

export function renameChecklist(ctx: Ctx, id: number, title: string): CardDetail {
  const list = checklistRow(ctx, id);
  getEditableCard(ctx, list.cardId);
  list.title = title;
  return changed(ctx, list.cardId);
}

export function deleteChecklist(ctx: Ctx, id: number): CardDetail {
  const list = checklistRow(ctx, id);
  getEditableCard(ctx, list.cardId);
  ctx.s.checklists = ctx.s.checklists.filter((l) => l.id !== id);
  ctx.s.checklistItems = ctx.s.checklistItems.filter((i) => i.checklistId !== id);
  listsOf(ctx, list.cardId)
    .sort(byPosition)
    .forEach((l, i) => (l.position = i));
  recordEvent(ctx, list.cardId, 'checklist_removed', { checklistId: id, title: list.title });
  return changed(ctx, list.cardId);
}

export function reorderChecklists(ctx: Ctx, cardId: number, ids: number[]): CardDetail {
  getEditableCard(ctx, cardId);
  reorder(listsOf(ctx, cardId), ids);
  return changed(ctx, cardId);
}

export function addChecklistItem(ctx: Ctx, checklistId: number, text: string): CardDetail {
  const list = checklistRow(ctx, checklistId);
  getEditableCard(ctx, list.cardId);
  const pos = Math.max(-1, ...itemsOf(ctx, checklistId).map((i) => i.position)) + 1;
  ctx.s.checklistItems.push({
    id: nextId(ctx, 'checklistItems'),
    checklistId,
    text,
    checked: false,
    checkedAt: null,
    position: pos,
    createdAt: nowIso(ctx),
  });
  return changed(ctx, list.cardId);
}

export function updateChecklistItem(ctx: Ctx, itemId: number, patch: { text?: string; checked?: boolean }): CardDetail {
  const item = itemRow(ctx, itemId);
  const list = checklistRow(ctx, item.checklistId);
  getEditableCard(ctx, list.cardId);
  if (patch.text !== undefined && patch.text !== item.text) item.text = patch.text;
  if (patch.checked !== undefined && patch.checked !== item.checked) {
    item.checked = patch.checked;
    item.checkedAt = patch.checked ? nowIso(ctx) : null;
    recordEvent(ctx, list.cardId, patch.checked ? 'checklist_item_checked' : 'checklist_item_unchecked', {
      checklistId: list.id,
      checklist: list.title,
      itemId,
      text: item.text,
    });
  }
  return changed(ctx, list.cardId);
}

export function deleteChecklistItem(ctx: Ctx, itemId: number): CardDetail {
  const item = itemRow(ctx, itemId);
  const list = checklistRow(ctx, item.checklistId);
  getEditableCard(ctx, list.cardId);
  ctx.s.checklistItems = ctx.s.checklistItems.filter((i) => i.id !== itemId);
  itemsOf(ctx, list.id)
    .sort(byPosition)
    .forEach((i, n) => (i.position = n));
  return changed(ctx, list.cardId);
}

export function reorderChecklistItems(ctx: Ctx, checklistId: number, ids: number[]): CardDetail {
  const list = checklistRow(ctx, checklistId);
  getEditableCard(ctx, list.cardId);
  reorder(itemsOf(ctx, checklistId), ids);
  return changed(ctx, list.cardId);
}

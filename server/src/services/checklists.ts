// Checklists and their items. Every change returns the full card (the UI re-renders it in one go)
// and keeps the search index in step. Adding/removing a checklist and checking/unchecking an item
// are logged; editing item text and reordering aren't (they'd drown the log).

import type { CardDetail } from '@tt/shared';
import { stmt } from '../db/connection';
import { badRequest, notFound } from '../errors';
import { recordEvent } from './activity';
import type { ChecklistItemRow, ChecklistRow } from './cardParts';
import { getCard, getEditableCard, touchCard } from './cards';
import { nowIso, tx, type Ctx } from './context';
import { reindexCard } from './search';

function checklistRow(ctx: Ctx, id: number): ChecklistRow {
  const row = stmt(ctx.db, 'SELECT * FROM checklists WHERE id = ?').get(id) as ChecklistRow | undefined;
  if (!row) throw notFound('Checklist not found');
  return row;
}

function itemRow(ctx: Ctx, id: number): ChecklistItemRow {
  const row = stmt(ctx.db, 'SELECT * FROM checklist_items WHERE id = ?').get(id) as ChecklistItemRow | undefined;
  if (!row) throw notFound('Checklist item not found');
  return row;
}

function changed(ctx: Ctx, cardId: number, reindex: boolean): CardDetail {
  touchCard(ctx, cardId);
  if (reindex) reindexCard(ctx, cardId);
  return getCard(ctx, cardId);
}

/** Ids must be exactly the current set, in the new order. */
function reorder(ctx: Ctx, table: 'checklists' | 'checklist_items', existing: number[], ids: number[]): void {
  const a = [...existing].sort((x, y) => x - y);
  const b = [...ids].sort((x, y) => x - y);
  if (a.length !== b.length || a.some((v, i) => v !== b[i])) {
    throw badRequest('validation', 'ids must contain every item exactly once');
  }
  const update = stmt(ctx.db, `UPDATE ${table} SET position = ? WHERE id = ?`);
  ids.forEach((id, i) => update.run(i, id));
}

export function addChecklist(ctx: Ctx, cardId: number, title: string): CardDetail {
  return tx(ctx, () => {
    getEditableCard(ctx, cardId);
    const pos = stmt(ctx.db, 'SELECT coalesce(max(position), -1) + 1 FROM checklists WHERE card_id = ?')
      .pluck()
      .get(cardId) as number;
    const id = Number(
      stmt(ctx.db, 'INSERT INTO checklists (card_id, title, position, created_at) VALUES (?, ?, ?, ?)').run(
        cardId,
        title,
        pos,
        nowIso(ctx),
      ).lastInsertRowid,
    );
    recordEvent(ctx, cardId, 'checklist_added', { checklistId: id, title });
    return changed(ctx, cardId, true);
  });
}

export function renameChecklist(ctx: Ctx, id: number, title: string): CardDetail {
  return tx(ctx, () => {
    const list = checklistRow(ctx, id);
    getEditableCard(ctx, list.card_id);
    stmt(ctx.db, 'UPDATE checklists SET title = ? WHERE id = ?').run(title, id);
    return changed(ctx, list.card_id, true);
  });
}

export function deleteChecklist(ctx: Ctx, id: number): CardDetail {
  return tx(ctx, () => {
    const list = checklistRow(ctx, id);
    getEditableCard(ctx, list.card_id);
    stmt(ctx.db, 'DELETE FROM checklists WHERE id = ?').run(id); // items cascade
    const ids = stmt(ctx.db, 'SELECT id FROM checklists WHERE card_id = ? ORDER BY position, id')
      .pluck()
      .all(list.card_id) as number[];
    reorder(ctx, 'checklists', ids, ids);
    recordEvent(ctx, list.card_id, 'checklist_removed', { checklistId: id, title: list.title });
    return changed(ctx, list.card_id, true);
  });
}

export function reorderChecklists(ctx: Ctx, cardId: number, ids: number[]): CardDetail {
  return tx(ctx, () => {
    getEditableCard(ctx, cardId);
    const existing = stmt(ctx.db, 'SELECT id FROM checklists WHERE card_id = ? ORDER BY id').pluck().all(cardId) as number[];
    reorder(ctx, 'checklists', existing, ids);
    return changed(ctx, cardId, true);
  });
}

export function addChecklistItem(ctx: Ctx, checklistId: number, text: string): CardDetail {
  return tx(ctx, () => {
    const list = checklistRow(ctx, checklistId);
    getEditableCard(ctx, list.card_id);
    const pos = stmt(ctx.db, 'SELECT coalesce(max(position), -1) + 1 FROM checklist_items WHERE checklist_id = ?')
      .pluck()
      .get(checklistId) as number;
    stmt(ctx.db, 'INSERT INTO checklist_items (checklist_id, text, position, created_at) VALUES (?, ?, ?, ?)').run(
      checklistId,
      text,
      pos,
      nowIso(ctx),
    );
    return changed(ctx, list.card_id, true);
  });
}

export function updateChecklistItem(ctx: Ctx, itemId: number, patch: { text?: string; checked?: boolean }): CardDetail {
  return tx(ctx, () => {
    const item = itemRow(ctx, itemId);
    const list = checklistRow(ctx, item.checklist_id);
    getEditableCard(ctx, list.card_id);
    let reindex = false;
    if (patch.text !== undefined && patch.text !== item.text) {
      stmt(ctx.db, 'UPDATE checklist_items SET text = ? WHERE id = ?').run(patch.text, itemId);
      reindex = true;
    }
    if (patch.checked !== undefined && patch.checked !== (item.checked === 1)) {
      stmt(ctx.db, 'UPDATE checklist_items SET checked = ?, checked_at = ? WHERE id = ?').run(
        patch.checked ? 1 : 0,
        patch.checked ? nowIso(ctx) : null,
        itemId,
      );
      recordEvent(ctx, list.card_id, patch.checked ? 'checklist_item_checked' : 'checklist_item_unchecked', {
        checklistId: list.id,
        checklist: list.title,
        itemId,
        text: patch.text ?? item.text,
      });
    }
    return changed(ctx, list.card_id, reindex);
  });
}

export function deleteChecklistItem(ctx: Ctx, itemId: number): CardDetail {
  return tx(ctx, () => {
    const item = itemRow(ctx, itemId);
    const list = checklistRow(ctx, item.checklist_id);
    getEditableCard(ctx, list.card_id);
    stmt(ctx.db, 'DELETE FROM checklist_items WHERE id = ?').run(itemId);
    const ids = stmt(ctx.db, 'SELECT id FROM checklist_items WHERE checklist_id = ? ORDER BY position, id')
      .pluck()
      .all(list.id) as number[];
    reorder(ctx, 'checklist_items', ids, ids);
    return changed(ctx, list.card_id, true);
  });
}

export function reorderChecklistItems(ctx: Ctx, checklistId: number, ids: number[]): CardDetail {
  return tx(ctx, () => {
    const list = checklistRow(ctx, checklistId);
    getEditableCard(ctx, list.card_id);
    const existing = stmt(ctx.db, 'SELECT id FROM checklist_items WHERE checklist_id = ? ORDER BY id')
      .pluck()
      .all(checklistId) as number[];
    reorder(ctx, 'checklist_items', existing, ids);
    return changed(ctx, list.card_id, false);
  });
}

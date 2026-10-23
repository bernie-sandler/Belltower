import type {
  BoardResponse,
  CardDetail,
  CardSource,
  CardTile,
  MoveCardResponse,
  Priority,
  Severity,
} from '@tt/shared';
import { PRIORITIES, SEVERITIES } from '@tt/shared';
import { stmt } from '../db/connection';
import { badRequest, conflict, notFound } from '../errors';
import { columnRef, labelRef, recordEvent } from './activity';
import { listAttachments, listChecklists, listLinks } from './cardParts';
import { getColumnRow, getRoleColumn, listColumns, type ColumnRow } from './columns';
import { nowIso, tx, type Ctx } from './context';
import { listLabels, resolveLabels, type LabelRow } from './labels';
import { reindexCard } from './search';

export interface CardRow {
  id: number;
  column_id: number;
  title: string;
  description_md: string;
  priority: Priority | null;
  severity: Severity | null;
  due_date: string | null;
  due_time: string | null;
  position: number;
  version: number;
  completed_at: string | null;
  archived_at: string | null;
  deleted_at: string | null;
  source: CardSource;
  source_ref: string | null;
  template_id: number | null;
  created_at: string;
  updated_at: string;
}

interface TileRow extends CardRow {
  label_ids: string | null;
  attachment_count: number;
  link_count: number;
  checklist_done: number;
  checklist_total: number;
}

const TILE_SELECT = `
SELECT c.*,
  (SELECT group_concat(cl.label_id, ',' ORDER BY l.position, l.id)
     FROM card_labels cl JOIN labels l ON l.id = cl.label_id WHERE cl.card_id = c.id) AS label_ids,
  (SELECT count(*) FROM attachments a WHERE a.card_id = c.id) AS attachment_count,
  (SELECT count(*) FROM card_links k
     JOIN cards o ON o.id = CASE WHEN k.from_card_id = c.id THEN k.to_card_id ELSE k.from_card_id END
    WHERE (k.from_card_id = c.id OR k.to_card_id = c.id) AND o.deleted_at IS NULL) AS link_count,
  (SELECT count(*) FROM checklist_items i JOIN checklists ch ON ch.id = i.checklist_id
    WHERE ch.card_id = c.id AND i.checked = 1) AS checklist_done,
  (SELECT count(*) FROM checklist_items i JOIN checklists ch ON ch.id = i.checklist_id
    WHERE ch.card_id = c.id) AS checklist_total
FROM cards c`;

/** Cards shown on the board: not archived, not in Trash. */
const VISIBLE = 'deleted_at IS NULL AND archived_at IS NULL';

function toTile(r: TileRow): CardTile {
  return {
    id: r.id,
    columnId: r.column_id,
    title: r.title,
    position: r.position,
    priority: r.priority,
    severity: r.severity,
    dueDate: r.due_date,
    dueTime: r.due_time,
    completedAt: r.completed_at,
    labelIds: r.label_ids ? r.label_ids.split(',').map(Number) : [],
    attachmentCount: r.attachment_count,
    linkCount: r.link_count,
    checklistDone: r.checklist_done,
    checklistTotal: r.checklist_total,
    version: r.version,
  };
}

function toDetail(ctx: Ctx, r: TileRow): CardDetail {
  return {
    ...toTile(r),
    description: r.description_md,
    archivedAt: r.archived_at,
    deletedAt: r.deleted_at,
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    checklists: listChecklists(ctx, r.id),
    attachments: listAttachments(ctx, r.id),
    links: listLinks(ctx, r.id),
  };
}

function tileRow(ctx: Ctx, id: number): TileRow {
  const row = stmt(ctx.db, `${TILE_SELECT} WHERE c.id = ?`).get(id) as TileRow | undefined;
  if (!row) throw notFound('Card not found');
  return row;
}

export function getCardRow(ctx: Ctx, id: number): CardRow {
  const row = stmt(ctx.db, 'SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined;
  if (!row) throw notFound('Card not found');
  return row;
}

export function getCard(ctx: Ctx, id: number): CardDetail {
  return toDetail(ctx, tileRow(ctx, id));
}

/** Marks a card as changed (updated_at) for edits that live in other tables. */
export function touchCard(ctx: Ctx, id: number): void {
  stmt(ctx.db, 'UPDATE cards SET updated_at = ? WHERE id = ?').run(nowIso(ctx), id);
}

/** Cards in the Trash are read-only until restored. */
export function getEditableCard(ctx: Ctx, id: number): CardRow {
  const card = getCardRow(ctx, id);
  if (card.deleted_at) throw conflict('card_deleted', 'This card is in the Trash; restore it before editing');
  return card;
}

export function getCardTile(ctx: Ctx, id: number): CardTile {
  return toTile(tileRow(ctx, id));
}

export function getBoard(ctx: Ctx): BoardResponse {
  const rows = stmt(
    ctx.db,
    `${TILE_SELECT} JOIN columns col ON col.id = c.column_id
      WHERE c.deleted_at IS NULL AND c.archived_at IS NULL
      ORDER BY col.position, c.position, c.id`,
  ).all() as TileRow[];
  return { columns: listColumns(ctx), labels: listLabels(ctx), cards: rows.map(toTile) };
}

function visibleIdsInColumn(ctx: Ctx, columnId: number): number[] {
  return stmt(ctx.db, `SELECT id FROM cards WHERE column_id = ? AND ${VISIBLE} ORDER BY position, id`)
    .pluck()
    .all(columnId) as number[];
}

function writePositions(ctx: Ctx, ids: number[]): void {
  const update = stmt(ctx.db, 'UPDATE cards SET position = ? WHERE id = ?');
  ids.forEach((id, i) => update.run(i, id));
}

function bottomPosition(ctx: Ctx, columnId: number): number {
  return stmt(ctx.db, `SELECT coalesce(max(position), -1) + 1 FROM cards WHERE column_id = ? AND ${VISIBLE}`)
    .pluck()
    .get(columnId) as number;
}

/** A column named in a request body. Missing = the client's board is stale: 400, not 404. */
function targetColumn(ctx: Ctx, id: number): ColumnRow {
  const row = stmt(ctx.db, 'SELECT * FROM columns WHERE id = ?').get(id) as ColumnRow | undefined;
  if (!row) throw badRequest('invalid_target', 'That column no longer exists; refresh the board and try again');
  return row;
}

function labelsOf(ctx: Ctx, cardId: number): LabelRow[] {
  return stmt(
    ctx.db,
    'SELECT l.* FROM card_labels cl JOIN labels l ON l.id = cl.label_id WHERE cl.card_id = ? ORDER BY l.position, l.id',
  ).all(cardId) as LabelRow[];
}

// ---------------------------------------------------------------------------------------------
// Creation — the single entry point for every card source (UI, recurring templates, v2 API).
// ---------------------------------------------------------------------------------------------

/** Allowed clock skew for "not in the future" checks (phone clocks drift). */
export const FUTURE_SLACK_MS = 5 * 60 * 1000;

export interface CreateCardInput {
  title: string;
  description?: string;
  /** Defaults to the Triage-role column. */
  columnId?: number;
  labelIds?: number[];
  /** Resolved case-insensitively; missing labels are created. */
  labelNames?: string[];
  priority?: Priority | null;
  severity?: Severity | null;
  dueDate?: string | null;
  dueTime?: string | null;
  position?: 'top' | 'bottom';
  checklists?: { title: string; items: string[] }[];
}

export interface CreateCardOptions {
  source?: CardSource;
  sourceRef?: string | null;
  templateId?: number | null;
  templateTitle?: string;
}

export function createCard(ctx: Ctx, input: CreateCardInput, opts: CreateCardOptions = {}): CardDetail {
  const title = input.title.trim();
  if (!title) throw badRequest('validation', 'Title is required');
  if (input.dueTime && !input.dueDate) throw badRequest('validation', 'dueTime requires dueDate');

  return tx(ctx, () => {
    const column = input.columnId !== undefined ? targetColumn(ctx, input.columnId) : getRoleColumn(ctx, 'triage');
    const labels = resolveLabels(ctx, input.labelIds, input.labelNames);
    const now = nowIso(ctx);

    let position: number;
    if (input.position === 'top') {
      stmt(ctx.db, `UPDATE cards SET position = position + 1 WHERE column_id = ? AND ${VISIBLE}`).run(column.id);
      position = 0;
    } else {
      position = bottomPosition(ctx, column.id);
    }

    const info = stmt(
      ctx.db,
      `INSERT INTO cards (column_id, title, description_md, priority, severity, due_date, due_time, position,
                          completed_at, source, source_ref, template_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      column.id,
      title,
      input.description ?? '',
      input.priority ?? null,
      input.severity ?? null,
      input.dueDate ?? null,
      input.dueDate ? (input.dueTime ?? null) : null,
      position,
      column.role === 'done' ? now : null,
      opts.source ?? 'manual',
      opts.sourceRef ?? null,
      opts.templateId ?? null,
      now,
      now,
    );
    const id = Number(info.lastInsertRowid);

    const addLabel = stmt(ctx.db, 'INSERT INTO card_labels (card_id, label_id) VALUES (?, ?)');
    for (const l of labels) addLabel.run(id, l.id);

    input.checklists?.forEach((cl, i) => {
      const listId = Number(
        stmt(ctx.db, 'INSERT INTO checklists (card_id, title, position, created_at) VALUES (?, ?, ?, ?)').run(
          id,
          cl.title,
          i,
          now,
        ).lastInsertRowid,
      );
      const addItem = stmt(
        ctx.db,
        'INSERT INTO checklist_items (checklist_id, text, position, created_at) VALUES (?, ?, ?, ?)',
      );
      cl.items.forEach((text, j) => addItem.run(listId, text, j, now));
    });

    recordEvent(ctx, id, 'created', {
      column: columnRef(column),
      title,
      source: opts.source ?? 'manual',
      ...(opts.templateId ? { templateId: opts.templateId, templateTitle: opts.templateTitle } : {}),
    });
    reindexCard(ctx, id);
    return getCard(ctx, id);
  });
}

// ---------------------------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------------------------

export interface UpdateCardInput {
  expectedVersion?: number;
  title?: string;
  description?: string;
  labelIds?: number[];
  priority?: Priority | null;
  severity?: Severity | null;
  dueDate?: string | null;
  dueTime?: string | null;
  completedAt?: string;
}

function assertEditable(card: CardRow): void {
  if (card.deleted_at) throw conflict('card_deleted', 'This card is in the Trash; restore it before editing');
}

/** Applies the changed fields, logging one event per field. Version bumps only on a real change. */
export function updateCard(ctx: Ctx, id: number, patch: UpdateCardInput): CardDetail {
  return tx(ctx, () => {
    const card = getCardRow(ctx, id);
    assertEditable(card);
    if (patch.expectedVersion !== undefined && patch.expectedVersion !== card.version) {
      throw conflict('version_conflict', 'This card was changed somewhere else', { card: getCard(ctx, id) });
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    let changed = false;
    let reindex = false;

    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (!title) throw badRequest('validation', 'Title is required');
      if (title !== card.title) {
        sets.push('title = ?');
        params.push(title);
        recordEvent(ctx, id, 'title_changed', { from: card.title, to: title });
        reindex = true;
      }
    }

    if (patch.description !== undefined && patch.description !== card.description_md) {
      sets.push('description_md = ?');
      params.push(patch.description);
      recordEvent(ctx, id, 'description_changed', { from: card.description_md, to: patch.description });
      reindex = true;
    }

    if (patch.priority !== undefined && patch.priority !== card.priority) {
      sets.push('priority = ?');
      params.push(patch.priority);
      recordEvent(ctx, id, 'priority_changed', { from: card.priority, to: patch.priority });
    }

    if (patch.severity !== undefined && patch.severity !== card.severity) {
      sets.push('severity = ?');
      params.push(patch.severity);
      recordEvent(ctx, id, 'severity_changed', { from: card.severity, to: patch.severity });
    }

    if (patch.dueDate !== undefined || patch.dueTime !== undefined) {
      const date = patch.dueDate !== undefined ? patch.dueDate : card.due_date;
      let time = patch.dueTime !== undefined ? patch.dueTime : card.due_time;
      if (!date) time = null;
      if (patch.dueTime && !date) throw badRequest('validation', 'dueTime requires dueDate');
      if (date !== card.due_date || time !== card.due_time) {
        sets.push('due_date = ?', 'due_time = ?');
        params.push(date, time);
        recordEvent(ctx, id, 'due_changed', {
          from: card.due_date ? { date: card.due_date, time: card.due_time } : null,
          to: date ? { date, time } : null,
        });
      }
    }

    if (patch.labelIds !== undefined) {
      const current = labelsOf(ctx, id);
      const next = resolveLabels(ctx, patch.labelIds);
      const currentIds = new Set(current.map((l) => l.id));
      const nextIds = new Set(next.map((l) => l.id));
      const added = next.filter((l) => !currentIds.has(l.id));
      const removed = current.filter((l) => !nextIds.has(l.id));
      if (added.length || removed.length) {
        const add = stmt(ctx.db, 'INSERT INTO card_labels (card_id, label_id) VALUES (?, ?)');
        const del = stmt(ctx.db, 'DELETE FROM card_labels WHERE card_id = ? AND label_id = ?');
        for (const l of added) add.run(id, l.id);
        for (const l of removed) del.run(id, l.id);
        recordEvent(ctx, id, 'labels_changed', { added: added.map(labelRef), removed: removed.map(labelRef) });
        changed = true;
      }
    }

    if (patch.completedAt !== undefined && patch.completedAt !== card.completed_at) {
      if (!card.completed_at) {
        throw conflict('not_done', 'Only a completed card (in the Done column) has a completion date');
      }
      if (Date.parse(patch.completedAt) > ctx.clock.now().getTime() + FUTURE_SLACK_MS) {
        throw badRequest('validation', "The completion date can't be in the future");
      }
      sets.push('completed_at = ?');
      params.push(patch.completedAt);
      recordEvent(ctx, id, 'completion_changed', { from: card.completed_at, to: patch.completedAt });
    }

    if (sets.length || changed) {
      sets.push('version = version + 1', 'updated_at = ?');
      stmt(ctx.db, `UPDATE cards SET ${sets.join(', ')} WHERE id = ?`).run(
        ...params,
        nowIso(ctx),
        id,
      );
      if (reindex) reindexCard(ctx, id);
    }
    return getCard(ctx, id);
  });
}

// ---------------------------------------------------------------------------------------------
// Moving
// ---------------------------------------------------------------------------------------------

/**
 * Moves a card to `toColumnId`, directly after `afterCardId` (null = top). The anchor is a card id,
 * not an index, so the move is correct even when the client shows a filtered board. Only
 * board-visible cards are renumbered; archived/deleted cards keep their stale positions.
 */
export function moveCard(
  ctx: Ctx,
  id: number,
  input: { toColumnId: number; afterCardId: number | null },
): MoveCardResponse {
  return tx(ctx, () => {
    const card = getCardRow(ctx, id);
    assertEditable(card);
    if (card.archived_at) throw conflict('card_archived', 'Restore this card from the archive before moving it');
    const target = targetColumn(ctx, input.toColumnId);

    // "After itself" in its own column means "stay put" (e.g. Move to… → Bottom on the last card).
    if (input.afterCardId === id && card.column_id === target.id) {
      return { card: getCardTile(ctx, id), orders: { [String(target.id)]: visibleIdsInColumn(ctx, target.id) } };
    }

    const targetIds = visibleIdsInColumn(ctx, target.id).filter((cid) => cid !== id);
    let index = 0;
    if (input.afterCardId !== null) {
      const i = targetIds.indexOf(input.afterCardId);
      if (i < 0) {
        throw badRequest('anchor_not_found', 'That position no longer exists; refresh the board and try again');
      }
      index = i + 1;
    }
    targetIds.splice(index, 0, id);

    const orders: Record<string, number[]> = {};
    if (card.column_id !== target.id) {
      const from: ColumnRow = getColumnRow(ctx, card.column_id);
      const now = nowIso(ctx);
      let completedAt = card.completed_at;
      if (target.role === 'done' && from.role !== 'done') completedAt = now;
      if (from.role === 'done' && target.role !== 'done') completedAt = null;
      stmt(ctx.db, 'UPDATE cards SET column_id = ?, completed_at = ?, updated_at = ? WHERE id = ?').run(
        target.id,
        completedAt,
        now,
        id,
      );
      const sourceIds = visibleIdsInColumn(ctx, from.id);
      writePositions(ctx, sourceIds);
      orders[String(from.id)] = sourceIds;
      recordEvent(ctx, id, 'moved', { from: columnRef(from), to: columnRef(target) });
    }
    writePositions(ctx, targetIds);
    orders[String(target.id)] = targetIds;
    return { card: getCardTile(ctx, id), orders };
  });
}

// ---------------------------------------------------------------------------------------------
// Trash and archive
// ---------------------------------------------------------------------------------------------

/** Soft delete: the card, its files and its full history are kept and can be restored. */
export function deleteCard(ctx: Ctx, id: number): void {
  tx(ctx, () => {
    const card = getCardRow(ctx, id);
    if (card.deleted_at) return;
    const now = nowIso(ctx);
    stmt(ctx.db, 'UPDATE cards SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
    recordEvent(ctx, id, 'deleted', { column: columnRef(getColumnRow(ctx, card.column_id)) });
    reindexCard(ctx, id);
  });
}

export function undeleteCard(ctx: Ctx, id: number): CardDetail {
  return tx(ctx, () => {
    const card = getCardRow(ctx, id);
    if (!card.deleted_at) return getCard(ctx, id);
    const now = nowIso(ctx);
    const pos = card.archived_at ? card.position : bottomPosition(ctx, card.column_id);
    stmt(ctx.db, 'UPDATE cards SET deleted_at = NULL, position = ?, updated_at = ? WHERE id = ?').run(pos, now, id);
    recordEvent(ctx, id, 'undeleted', { column: columnRef(getColumnRow(ctx, card.column_id)) });
    reindexCard(ctx, id);
    return getCard(ctx, id);
  });
}

export function archiveCard(ctx: Ctx, id: number): CardDetail {
  return tx(ctx, () => {
    const card = getCardRow(ctx, id);
    assertEditable(card);
    if (card.archived_at) return getCard(ctx, id);
    const column = getColumnRow(ctx, card.column_id);
    if (column.role !== 'done') throw conflict('not_done', 'Only cards in the Done column can be archived');
    const now = nowIso(ctx);
    stmt(ctx.db, 'UPDATE cards SET archived_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
    writePositions(ctx, visibleIdsInColumn(ctx, column.id));
    recordEvent(ctx, id, 'archived', { column: columnRef(column) });
    return getCard(ctx, id);
  });
}

export function restoreCard(ctx: Ctx, id: number): CardDetail {
  return tx(ctx, () => {
    const card = getCardRow(ctx, id);
    assertEditable(card);
    if (!card.archived_at) return getCard(ctx, id);
    const now = nowIso(ctx);
    stmt(ctx.db, 'UPDATE cards SET archived_at = NULL, position = ?, updated_at = ? WHERE id = ?').run(
      bottomPosition(ctx, card.column_id),
      now,
      id,
    );
    recordEvent(ctx, id, 'restored', { column: columnRef(getColumnRow(ctx, card.column_id)) });
    return getCard(ctx, id);
  });
}


/** Archives every card in the Done column ("Archive all in Done"). Returns how many. */
export function archiveAllDone(ctx: Ctx): number {
  return tx(ctx, () => {
    const done = getRoleColumn(ctx, 'done');
    const ids = visibleIdsInColumn(ctx, done.id);
    for (const id of ids) archiveCard(ctx, id);
    return ids.length;
  });
}

const rank = <T extends string>(order: readonly T[], v: T | null) => (v === null ? order.length : order.indexOf(v));

/**
 * One-off "Sort by priority" for a column: P0 → P3, then S1 → S4 within a priority; cards with
 * neither go last. Ties keep their current order. A reorder, so nothing is logged.
 */
export function sortColumnByPriority(ctx: Ctx, columnId: number): Record<string, number[]> {
  return tx(ctx, () => {
    getColumnRow(ctx, columnId);
    const rows = stmt(
      ctx.db,
      `SELECT id, priority, severity FROM cards WHERE column_id = ? AND ${VISIBLE} ORDER BY position, id`,
    ).all(columnId) as { id: number; priority: Priority | null; severity: Severity | null }[];
    const sorted = rows
      .map((r, i) => ({ ...r, i }))
      .sort(
        (a, b) =>
          rank(PRIORITIES, a.priority) - rank(PRIORITIES, b.priority) ||
          rank(SEVERITIES, a.severity) - rank(SEVERITIES, b.severity) ||
          a.i - b.i,
      )
      .map((r) => r.id);
    writePositions(ctx, sorted);
    return { [String(columnId)]: sorted };
  });
}

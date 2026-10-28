import type {
  BoardResponse,
  CardKind,
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
import { assertNotBlocked, cardSummary, listAttachments, listChecklists, listChildren, listLinks, openBlockers } from './cardParts';
import { getBlockedColumnId, getColumnRow, getRoleColumn, listColumns, type ColumnRow } from './columns';
import { nowIso, tx, type Ctx } from './context';
import { listLabels, resolveLabels, type LabelRow } from './labels';
import { reindexCard } from './search';
import { localDateOf } from '../lib/localdate';

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
  ticket_no: string | null;
  kind: CardKind;
  parent_id: number | null;
  created_at: string;
  updated_at: string;
}

interface TileRow extends CardRow {
  label_ids: string | null;
  attachment_count: number;
  link_count: number;
  checklist_done: number;
  checklist_total: number;
  blocked_by: number;
  eff_parent_id: number | null;
  child_count: number;
  child_open: number;
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
    WHERE ch.card_id = c.id) AS checklist_total,
  (SELECT count(*) FROM card_links k JOIN cards b ON b.id = k.from_card_id
    WHERE k.to_card_id = c.id AND k.type = 'blocks' AND b.deleted_at IS NULL AND b.completed_at IS NULL) AS blocked_by,
  (SELECT p.id FROM cards p WHERE p.id = c.parent_id AND p.deleted_at IS NULL AND p.archived_at IS NULL) AS eff_parent_id,
  (SELECT count(*) FROM cards k WHERE k.parent_id = c.id AND k.deleted_at IS NULL) AS child_count,
  (SELECT count(*) FROM cards k WHERE k.parent_id = c.id AND k.deleted_at IS NULL AND k.completed_at IS NULL) AS child_open
FROM cards c`;

/** Cards shown on the board: not archived, not in Trash. */
const VISIBLE = 'deleted_at IS NULL AND archived_at IS NULL';

function toTile(r: TileRow): CardTile {
  return {
    id: r.id,
    ticketNo: r.ticket_no,
    kind: r.kind,
    parentId: r.eff_parent_id,
    childCount: r.child_count,
    childOpen: r.child_open,
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
    blockedBy: r.blocked_by,
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
    parent: r.parent_id !== null ? visibleSummary(ctx, r.parent_id) : null,
    children: r.kind === 'work' ? listChildren(ctx, r.id) : [],
  };
}

function visibleSummary(ctx: Ctx, id: number) {
  const s = cardSummary(ctx, id);
  return s && !s.deletedAt ? s : null;
}

/** What history stores about the other card in a parent/child event. */
function familyRef(card: { id: number; ticket_no: string | null; title: string }) {
  return { id: card.id, ticketNo: card.ticket_no, title: card.title };
}

/** Checks a card's type and the work card it would be filed under (400 invalid_parent). */
function checkFamily(ctx: Ctx, kind: CardKind, parentId: number | null, selfId: number | null): CardRow | null {
  if (parentId === null) return null;
  if (kind === 'work') throw badRequest('invalid_parent', "A work card can't be part of another card");
  if (parentId === selfId) throw badRequest('invalid_parent', "A card can't be part of itself");
  const parent = stmt(ctx.db, 'SELECT * FROM cards WHERE id = ?').get(parentId) as CardRow | undefined;
  if (!parent || parent.deleted_at) throw badRequest('invalid_parent', 'That work card no longer exists');
  if (parent.kind !== 'work') throw badRequest('invalid_parent', 'Tickets can only be filed under a work card');
  return parent;
}

function openChildCount(ctx: Ctx, id: number): number {
  return stmt(ctx.db, 'SELECT count(*) FROM cards WHERE parent_id = ? AND deleted_at IS NULL').pluck().get(id) as number;
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
  return {
    columns: listColumns(ctx),
    labels: listLabels(ctx),
    cards: rows.map(toTile),
    blockedColumnId: getBlockedColumnId(ctx),
  };
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
  /** Default 'ticket'. */
  kind?: CardKind;
  /** The work card this ticket is part of. */
  parentId?: number | null;
}

export interface CreateCardOptions {
  source?: CardSource;
  sourceRef?: string | null;
  templateId?: number | null;
  templateTitle?: string;
  /** How a card from outside arrived, e.g. 'card import' (recorded on the 'created' event). */
  via?: string;
}

/**
 * The next ticket number for a card created at `at`: "YYMMDD-N", where YYMMDD is the local date
 * (app time zone) and N counts up from 1 each day. Numbers are never reused, not even after a card
 * is deleted from the Trash view (cards are never really deleted).
 */
export function nextTicketNo(ctx: Ctx, at: Date): string {
  const prefix = localDateOf(at, ctx.tz).slice(2).replace(/-/g, '');
  const max = stmt(ctx.db, "SELECT max(CAST(substr(ticket_no, 8) AS INTEGER)) FROM cards WHERE ticket_no LIKE ? || '-%'")
    .pluck()
    .get(prefix) as number | null;
  return `${prefix}-${(max ?? 0) + 1}`;
}

/** Numbers cards that don't have a ticket number yet (from before 0.6, or an older backup), oldest first. */
export function assignTicketNumbers(ctx: Ctx): number {
  return tx(ctx, () => {
    const rows = stmt(ctx.db, 'SELECT id, created_at FROM cards WHERE ticket_no IS NULL ORDER BY created_at, id').all() as {
      id: number;
      created_at: string;
    }[];
    const set = stmt(ctx.db, 'UPDATE cards SET ticket_no = ? WHERE id = ?');
    for (const r of rows) set.run(nextTicketNo(ctx, new Date(r.created_at)), r.id);
    return rows.length;
  });
}

export function createCard(ctx: Ctx, input: CreateCardInput, opts: CreateCardOptions = {}): CardDetail {
  const title = input.title.trim();
  if (!title) throw badRequest('validation', 'Title is required');
  if (input.dueTime && !input.dueDate) throw badRequest('validation', 'dueTime requires dueDate');

  const kind = input.kind ?? 'ticket';
  return tx(ctx, () => {
    const parent = checkFamily(ctx, kind, input.parentId ?? null, null);
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

    const ticketNo = nextTicketNo(ctx, ctx.clock.now());
    const info = stmt(
      ctx.db,
      `INSERT INTO cards (column_id, title, description_md, priority, severity, due_date, due_time, position,
                          completed_at, source, source_ref, template_id, ticket_no, kind, parent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      ticketNo,
      kind,
      parent?.id ?? null,
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
      ticketNo,
      source: opts.source ?? 'manual',
      ...(opts.templateId ? { templateId: opts.templateId, templateTitle: opts.templateTitle } : {}),
      ...(opts.via ? { via: opts.via } : {}),
      ...(kind === 'work' ? { kind } : {}),
      ...(parent ? { parent: familyRef(parent) } : {}),
    });
    if (parent) {
      recordEvent(ctx, parent.id, 'child_added', { child: { id, ticketNo, title } });
      touchCard(ctx, parent.id);
    }
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
  kind?: CardKind;
  parentId?: number | null;
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

    // Type and "part of": validated together, since changing one can make the other invalid.
    const kind = patch.kind ?? card.kind;
    const parentId = patch.parentId !== undefined ? patch.parentId : card.parent_id;
    if (kind !== card.kind || parentId !== card.parent_id) {
      if (kind === 'ticket' && card.kind === 'work') {
        const n = openChildCount(ctx, id);
        if (n) {
          throw badRequest('invalid_parent', `This work card still has ${n} ticket${n === 1 ? '' : 's'}; move ${n === 1 ? 'it' : 'them'} out first`);
        }
      }
      if (kind === 'work' && parentId !== null && patch.parentId === undefined) {
        throw badRequest('invalid_parent', 'Take this ticket out of its work card before making it a work card');
      }
      const parent = checkFamily(ctx, kind, parentId, id);
      if (kind !== card.kind) {
        sets.push('kind = ?');
        params.push(kind);
        recordEvent(ctx, id, 'kind_changed', { from: card.kind, to: kind });
      }
      if (parentId !== card.parent_id) {
        const old = card.parent_id !== null ? (stmt(ctx.db, 'SELECT * FROM cards WHERE id = ?').get(card.parent_id) as CardRow) : null;
        sets.push('parent_id = ?');
        params.push(parentId);
        recordEvent(ctx, id, 'parent_changed', { from: old ? familyRef(old) : null, to: parent ? familyRef(parent) : null });
        const self = familyRef({ ...card, title: patch.title?.trim() || card.title });
        if (old) {
          recordEvent(ctx, old.id, 'child_removed', { child: self });
          touchCard(ctx, old.id);
        }
        if (parent) {
          recordEvent(ctx, parent.id, 'child_added', { child: self });
          touchCard(ctx, parent.id);
        }
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
  opts: { skipBlockCheck?: boolean } = {},
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
      if (target.role === 'done' && from.role !== 'done') {
        if (!opts.skipBlockCheck) assertNotBlocked(ctx, card);
        completedAt = now;
      }
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
      // Reopening a finished card makes the cards it blocks blocked again.
      if (from.role === 'done' && target.role !== 'done') parkCardsBlockedBy(ctx, id);
    }
    writePositions(ctx, targetIds);
    orders[String(target.id)] = targetIds;
    return { card: getCardTile(ctx, id), orders };
  });
}

/**
 * Mark done: moves the card to the top of Done and, with includeChildren, every open ticket filed
 * under it too. All or nothing: if any of them is blocked by a card outside the set, nothing moves
 * (409 blocked, listing each stuck card and its blockers).
 */
export function completeCard(
  ctx: Ctx,
  id: number,
  opts: { includeChildren: boolean },
): { card: CardDetail; orders: Record<string, number[]>; completed: number[] } {
  return tx(ctx, () => {
    const card = getCardRow(ctx, id);
    assertEditable(card);
    if (card.archived_at) throw conflict('card_archived', 'Restore this card from the archive first');
    const done = getRoleColumn(ctx, 'done');
    const children =
      opts.includeChildren && card.kind === 'work'
        ? (stmt(
            ctx.db,
            `SELECT * FROM cards WHERE parent_id = ? AND deleted_at IS NULL AND archived_at IS NULL AND completed_at IS NULL
              ORDER BY position, id`,
          ).all(id) as CardRow[])
        : [];
    // Children first, the work card last, so it ends up on top of Done.
    const targets = [...children, ...(card.completed_at ? [] : [card])];
    const ids = new Set(targets.map((c) => c.id));

    const stuck = targets
      .map((c) => ({ id: c.id, ticketNo: c.ticket_no, title: c.title, blockers: openBlockers(ctx, c.id).filter((b) => !ids.has(b.id)) }))
      .filter((s) => s.blockers.length);
    if (stuck.length) {
      const names = stuck.slice(0, 3).map((s) => `“${s.title}”`).join(', ');
      const more = stuck.length > 3 ? ` and ${stuck.length - 3} more` : '';
      throw conflict(
        'blocked',
        `${names}${more} ${stuck.length === 1 ? 'is' : 'are'} still blocked by open cards, so nothing was completed.`,
        { blockers: stuck.flatMap((s) => s.blockers), stuck },
      );
    }

    const orders: Record<string, number[]> = {};
    for (const t of targets) {
      Object.assign(orders, moveCard(ctx, t.id, { toColumnId: done.id, afterCardId: null }, { skipBlockCheck: true }).orders);
    }
    return { card: getCard(ctx, id), orders, completed: targets.map((t) => t.id) };
  });
}

/**
 * Moves a card that has open blockers to the bottom of the blocked column (see getBlockedColumnId).
 * Done, archived and trashed cards stay put, as do cards already there. Returns whether it moved.
 */
export function parkIfBlocked(ctx: Ctx, id: number): boolean {
  const card = getCardRow(ctx, id);
  if (card.deleted_at || card.archived_at || card.completed_at) return false;
  const targetId = getBlockedColumnId(ctx);
  if (targetId === null || card.column_id === targetId) return false;
  const blockers = openBlockers(ctx, id);
  if (!blockers.length) return false;

  const from = getColumnRow(ctx, card.column_id);
  const target = getColumnRow(ctx, targetId);
  stmt(ctx.db, 'UPDATE cards SET column_id = ?, updated_at = ? WHERE id = ?').run(target.id, nowIso(ctx), id);
  writePositions(ctx, visibleIdsInColumn(ctx, from.id));
  writePositions(ctx, [...visibleIdsInColumn(ctx, target.id).filter((cid) => cid !== id), id]);
  recordEvent(ctx, id, 'moved', { from: columnRef(from), to: columnRef(target), reason: 'blocked', blockedBy: blockers });
  return true;
}

/** parkIfBlocked for every card that `blockerId` blocks. */
export function parkCardsBlockedBy(ctx: Ctx, blockerId: number): void {
  const ids = stmt(ctx.db, "SELECT to_card_id FROM card_links WHERE from_card_id = ? AND type = 'blocks'")
    .pluck()
    .all(blockerId) as number[];
  for (const id of ids) parkIfBlocked(ctx, id);
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
    parkCardsBlockedBy(ctx, id); // a restored open blocker blocks again
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

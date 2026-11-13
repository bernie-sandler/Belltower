import type {
  BoardResponse,
  CardKind,
  CardDetail,
  CardSource,
  CardTile,
  MoveCardResponse,
  MoveCardsResponse,
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
import { isWatching, notifyAssigned, notifyMoved, notifyNewUnassigned, notifySubmitted, watchOwnNewCard } from './notifications';
import { reindexCard } from './search';
import { assertUnrestricted, restrictedVisibleSql, userCanSeeCard, userTagScope, visibleIds, visibleOrders, visibleSql } from './scope';
import { findUser, type UserRow } from './users';
import { localDateOf } from '../lib/localdate';
import { getGeneralSettings, getResolutionReasons } from './settings';

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
  resolution: string | null;
  resolution_md: string;
  assignee_id: number | null;
  created_at: string;
  updated_at: string;
}

interface TileRow extends CardRow {
  label_ids: string | null;
  attachment_count: number;
  link_count: number;
  /** JSON ChecklistCounts. */
  checklist_counts: string;
  blocked_by: number;
  eff_parent_id: number | null;
  child_count: number;
  child_open: number;
}

/**
 * A card's checklist items: all, answered (done + failed), failed, unverified. One subquery returns all
 * four, because four separate count subqueries made a 2,000-ticket board noticeably slower.
 */
type ChecklistCounts = [total: number, done: number, failed: number, unverified: number];

/**
 * The tile query. Counts and the parent id only see cards `ctx` may see (scope.ts), so a
 * restricted account never learns about hidden linked, parent or child cards. `blocked_by` counts
 * every open blocker: it is the visible card's own state (it can't be completed yet).
 */
const tileSelect = (ctx: Ctx) => `
SELECT c.*,
  (SELECT group_concat(cl.label_id, ',' ORDER BY l.position, l.id)
     FROM card_labels cl JOIN labels l ON l.id = cl.label_id WHERE cl.card_id = c.id) AS label_ids,
  (SELECT count(*) FROM attachments a WHERE a.card_id = c.id) AS attachment_count,
  (SELECT count(*) FROM card_links k
     JOIN cards o ON o.id = CASE WHEN k.from_card_id = c.id THEN k.to_card_id ELSE k.from_card_id END
    WHERE (k.from_card_id = c.id OR k.to_card_id = c.id) AND o.deleted_at IS NULL AND ${visibleSql(ctx, 'o')}) AS link_count,
  (SELECT json_array(count(*), count(*) FILTER (WHERE i.state IN ('done', 'failed')),
          count(*) FILTER (WHERE i.state = 'failed'), count(*) FILTER (WHERE i.state = 'unverified'))
     FROM checklist_items i JOIN checklists ch ON ch.id = i.checklist_id WHERE ch.card_id = c.id) AS checklist_counts,
  (SELECT count(*) FROM card_links k JOIN cards b ON b.id = k.from_card_id
    WHERE k.to_card_id = c.id AND k.type = 'blocks' AND b.deleted_at IS NULL AND b.completed_at IS NULL) AS blocked_by,
  (SELECT p.id FROM cards p WHERE p.id = c.parent_id AND p.deleted_at IS NULL AND p.archived_at IS NULL
      AND ${visibleSql(ctx, 'p')}) AS eff_parent_id,
  (SELECT count(*) FROM cards k WHERE k.parent_id = c.id AND k.deleted_at IS NULL AND ${visibleSql(ctx, 'k')}) AS child_count,
  (SELECT count(*) FROM cards k WHERE k.parent_id = c.id AND k.deleted_at IS NULL AND k.completed_at IS NULL
      AND ${visibleSql(ctx, 'k')}) AS child_open
FROM cards c`;

/** Cards shown on the board: not archived, not in Trash. */
const VISIBLE = 'deleted_at IS NULL AND archived_at IS NULL';

function toTile(r: TileRow): CardTile {
  const [checklistTotal, checklistDone, checklistFailed, checklistUnverified] = JSON.parse(r.checklist_counts) as ChecklistCounts;
  return {
    id: r.id,
    ticketNo: r.ticket_no,
    kind: r.kind,
    parentId: r.eff_parent_id,
    childCount: r.child_count,
    childOpen: r.child_open,
    resolution: r.resolution,
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
    checklistDone,
    checklistTotal,
    checklistFailed,
    checklistUnverified,
    blockedBy: r.blocked_by,
    assigneeId: r.assignee_id,
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
    resolutionNote: r.resolution_md,
    watching: isWatching(ctx, r.id),
  };
}

/** setResolution for other services (import): the card must already be done. */
export function resolveCard(ctx: Ctx, id: number, res: { reason: string; note: string }): void {
  const row = getCardRow(ctx, id);
  if (row.completed_at) setResolution(ctx, row, res);
}

/**
 * Records how a done card was resolved (null clears it). Logged as `resolved`; history keeps every
 * version, so reopening a card and resolving it again never loses the earlier note.
 */
function setResolution(ctx: Ctx, card: CardRow, res: { reason: string; note: string } | null): void {
  const reason = res?.reason.trim() ?? null;
  const note = res?.note.trim() ?? '';
  if (reason === card.resolution && note === card.resolution_md) return;
  stmt(ctx.db, 'UPDATE cards SET resolution = ?, resolution_md = ?, version = version + 1, updated_at = ? WHERE id = ?').run(
    reason,
    note,
    nowIso(ctx),
    card.id,
  );
  recordEvent(ctx, card.id, 'resolved', { reason, note, from: card.resolution });
  reindexCard(ctx, card.id);
}

function visibleSummary(ctx: Ctx, id: number) {
  const s = cardSummary(ctx, id);
  return s && !s.deletedAt ? s : null;
}

/** What history stores about the other card in a parent/child event. */
function familyRef(card: { id: number; ticket_no: string | null; title: string }) {
  return { id: card.id, ticketNo: card.ticket_no, title: card.title };
}

/** Someone a card can be given to: an existing, active person (400 invalid_assignee / assignee_disabled). */
function checkAssignee(ctx: Ctx, userId: number): UserRow {
  const user = findUser(ctx, userId);
  if (!user) throw badRequest('invalid_assignee', 'That person doesn’t exist (anymore); reload and pick again');
  if (user.disabled_at) throw badRequest('assignee_disabled', `${user.display_name} is deactivated and can’t be assigned cards`);
  return user;
}

/** A tag-restricted person can only be given cards they can see (400 assignee_cant_see). */
function assertAssigneeSees(ctx: Ctx, user: UserRow, cardId: number): void {
  if (!userCanSeeCard(ctx, user.id, cardId)) {
    throw badRequest('assignee_cant_see', `${user.display_name} can’t see this ticket: it has none of their tags`);
  }
}

/**
 * After someone's tags were narrowed (or set): takes them off every card (not in the Trash) they
 * can no longer see, logging each as unassigned. Inside the caller's transaction. Returns how many.
 */
export function unassignHiddenCards(ctx: Ctx, userId: number): number {
  if (userTagScope(ctx, userId) === null) return 0;
  const ids = stmt(
    ctx.db,
    `SELECT c.id FROM cards c WHERE c.assignee_id = ? AND c.deleted_at IS NULL AND NOT ${restrictedVisibleSql(userId)} ORDER BY c.id`,
  )
    .pluck()
    .all(userId) as number[];
  const now = nowIso(ctx);
  for (const id of ids) {
    stmt(ctx.db, 'UPDATE cards SET assignee_id = NULL, version = version + 1, updated_at = ? WHERE id = ?').run(now, id);
    recordAssigned(ctx, id, userId, null);
  }
  return ids.length;
}

/** Logs and announces an assignee change, and tells the people concerned (inside the change's transaction). */
function recordAssigned(ctx: Ctx, cardId: number, from: number | null, to: UserRow | null): void {
  const fromName = from !== null ? (findUser(ctx, from)?.display_name ?? null) : null;
  const activityId = recordEvent(ctx, cardId, 'assigned', { from, to: to?.id ?? null, fromName, toName: to?.display_name ?? null });
  ctx.emit?.({ type: 'card_assigned', cardId, from, to: to?.id ?? null, actor: ctx.actor });
  notifyAssigned(ctx, cardId, activityId, { to: to ? { id: to.id, name: to.display_name } : null, fromName });
}

/** Checks a card's type and the work card it would be filed under (400 invalid_parent). */
function checkFamily(ctx: Ctx, kind: CardKind, parentId: number | null, selfId: number | null): CardRow | null {
  if (parentId === null) return null;
  if (kind === 'work') throw badRequest('invalid_parent', "A work card can't be part of another card");
  if (parentId === selfId) throw badRequest('invalid_parent', "A card can't be part of itself");
  const parent = stmt(ctx.db, `SELECT * FROM cards c WHERE c.id = ? AND ${visibleSql(ctx)}`).get(parentId) as CardRow | undefined;
  if (!parent || parent.deleted_at) throw badRequest('invalid_parent', 'That work card no longer exists');
  if (parent.kind !== 'work') throw badRequest('invalid_parent', 'Tickets can only be filed under a work card');
  return parent;
}

function openChildCount(ctx: Ctx, id: number): number {
  return stmt(ctx.db, 'SELECT count(*) FROM cards WHERE parent_id = ? AND deleted_at IS NULL').pluck().get(id) as number;
}

/** A card as a tile; 404 when it doesn't exist or `ctx` can't see it (unless `raw`). */
function tileRow(ctx: Ctx, id: number, raw = false): TileRow {
  const row = stmt(ctx.db, `${tileSelect(ctx)} WHERE c.id = ? AND ${raw ? '1' : visibleSql(ctx)}`).get(id) as TileRow | undefined;
  if (!row) throw notFound('Card not found');
  return row;
}

/**
 * The card a request names: 404 when it doesn't exist or the acting account can't see it (a
 * tag-restricted account, scope.ts), the same answer for both.
 */
export function getCardRow(ctx: Ctx, id: number): CardRow {
  const row = stmt(ctx.db, `SELECT * FROM cards c WHERE c.id = ? AND ${visibleSql(ctx)}`).get(id) as CardRow | undefined;
  if (!row) throw notFound('Card not found');
  return row;
}

/** getCardRow without the visibility check: only for knock-on changes to other cards (parking blocked cards). */
export function rawCardRow(ctx: Ctx, id: number): CardRow {
  const row = stmt(ctx.db, 'SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined;
  if (!row) throw notFound('Card not found');
  return row;
}

export function getCard(ctx: Ctx, id: number): CardDetail {
  return toDetail(ctx, tileRow(ctx, id));
}

/**
 * The card a person just changed, even if the change took it out of their view (they removed their
 * own tag). Its links, parent and children are still only the ones they can see.
 */
function changedCard(ctx: Ctx, id: number): CardDetail {
  return toDetail(ctx, tileRow(ctx, id, true));
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
    `${tileSelect(ctx)} JOIN columns col ON col.id = c.column_id
      WHERE c.deleted_at IS NULL AND c.archived_at IS NULL AND ${visibleSql(ctx)}
      ORDER BY col.position, c.position, c.id`,
  ).all() as TileRow[];
  return {
    columns: listColumns(ctx),
    labels: listLabels(ctx),
    cards: rows.map(toTile),
    blockedColumnId: getBlockedColumnId(ctx),
    resolutionReasons: getResolutionReasons(ctx),
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
  /** Who has it (an active person), or nobody. */
  assigneeId?: number | null;
}

export interface CreateCardOptions {
  source?: CardSource;
  sourceRef?: string | null;
  templateId?: number | null;
  templateTitle?: string;
  /** How a card from outside arrived, e.g. 'card import' (recorded on the 'created' event). */
  via?: string;
  /** Filed by someone or something else (submit page, API token): may trigger a notification. */
  external?: boolean;
  /** From the public submit page: tells admins (`submitted`), with Teams on or off. */
  submitPage?: boolean;
}

/**
 * The next ticket number for a card created at `at`, in the format set in Settings (default
 * "YYMMDD-N": the local date in the app time zone, and N counting up from 1 each day). Numbers are never reused, not even after a card
 * is deleted from the Trash view (cards are never really deleted).
 */
export function nextTicketNo(ctx: Ctx, at: Date): string {
  const prefix = ticketPrefix(getGeneralSettings(ctx).ticketFormat, localDateOf(at, ctx.tz));
  // The format can't contain % or _ (Settings refuses them), so the prefix is a literal LIKE pattern.
  const numbers = stmt(ctx.db, "SELECT substr(ticket_no, ?) FROM cards WHERE ticket_no LIKE ? || '%'")
    .pluck()
    .all(prefix.length + 1, prefix) as string[];
  const max = numbers.reduce((m, n) => (/^\d+$/.test(n) ? Math.max(m, Number(n)) : m), 0);
  return `${prefix}${max + 1}`;
}

/** The ticket number up to the counter, e.g. "{YY}{MM}{DD}-{N}" on 2026-10-24 → "261024-". */
export function ticketPrefix(format: string, localDate: string): string {
  const [yyyy, mm, dd] = localDate.split('-') as [string, string, string];
  return format
    .replace(/\{N\}$/, '')
    .replace(/\{YYYY\}/g, yyyy)
    .replace(/\{YY\}/g, yyyy.slice(2))
    .replace(/\{MM\}/g, mm)
    .replace(/\{DD\}/g, dd);
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
    const assignee = input.assigneeId != null ? checkAssignee(ctx, input.assigneeId) : null;
    const column = input.columnId !== undefined ? targetColumn(ctx, input.columnId) : getRoleColumn(ctx, 'triage');
    const labels = resolveLabels(ctx, input.labelIds, input.labelNames);
    // A tag-restricted person's new card carries at least one of their tags, so they can see it.
    const scope = ctx.scope;
    if (scope && !labels.some((l) => scope.labelIds.includes(l.id))) {
      if (!scope.labelIds.length) assertUnrestricted(ctx, 'create tickets while none of your tags exist');
      labels.push(...resolveLabels(ctx, scope.labelIds));
    }
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
                          completed_at, source, source_ref, template_id, ticket_no, kind, parent_id, assignee_id,
                          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      assignee?.id ?? null,
      now,
      now,
    );
    const id = Number(info.lastInsertRowid);

    const addLabel = stmt(ctx.db, 'INSERT INTO card_labels (card_id, label_id) VALUES (?, ?)');
    for (const l of labels) addLabel.run(id, l.id);
    if (assignee) assertAssigneeSees(ctx, assignee, id);

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

    const createdId = recordEvent(ctx, id, 'created', {
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
    ctx.emit?.({ type: 'card_created', cardId: id, external: opts.external ?? false, ...(opts.via ? { via: opts.via } : {}), actor: ctx.actor });
    // Made in the app by a person: they watch it. (Imports, templates and outside tickets: nobody.)
    if ((opts.source ?? 'manual') === 'manual' && !opts.external) watchOwnNewCard(ctx, id);
    // A submit-page ticket rings once per person: "submitted" wins over "new_unassigned".
    const submittedTold = opts.submitPage ? notifySubmitted(ctx, id, createdId, opts.via) : undefined;
    if (assignee) recordAssigned(ctx, id, null, assignee);
    else if (opts.external) notifyNewUnassigned(ctx, id, createdId, opts.via, submittedTold);
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
  /** An active person, or null for nobody. */
  assigneeId?: number | null;
  resolution?: { reason: string; note: string } | null;
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
          // A tag-restricted person isn't told how many (some may be hidden from them).
          throw badRequest(
            'invalid_parent',
            ctx.scope
              ? 'This work card still has tickets filed under it; they have to be moved out first'
              : `This work card still has ${n} ticket${n === 1 ? '' : 's'}; move ${n === 1 ? 'it' : 'them'} out first`,
          );
        }
      }
      if (kind === 'work' && parentId !== null && patch.parentId === undefined) {
        // A tag-restricted person may not see the work card, so they aren't told it's there.
        throw badRequest(
          'invalid_parent',
          ctx.scope ? 'This ticket can’t be made a work card right now' : 'Take this ticket out of its work card before making it a work card',
        );
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

    // Unassigning always works; a new assignee must be an active person.
    let assigned: { from: number | null; to: UserRow | null } | null = null;
    if (patch.assigneeId !== undefined && patch.assigneeId !== card.assignee_id) {
      const to = patch.assigneeId !== null ? checkAssignee(ctx, patch.assigneeId) : null;
      // Judged after the label change above, which runs first.
      if (to) assertAssigneeSees(ctx, to, id);
      sets.push('assignee_id = ?');
      params.push(to?.id ?? null);
      assigned = { from: card.assignee_id, to };
    } else if (patch.labelIds !== undefined && card.assignee_id !== null && !userCanSeeCard(ctx, card.assignee_id, id)) {
      // The new tags took the card out of a tag-restricted assignee's view: nobody has it now.
      sets.push('assignee_id = ?');
      params.push(null);
      assigned = { from: card.assignee_id, to: null };
    }

    if (patch.resolution !== undefined) {
      if (!card.completed_at) throw conflict('not_done', 'Only a done card has a resolution');
      setResolution(ctx, rawCardRow(ctx, id), patch.resolution);
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
      if (assigned) recordAssigned(ctx, id, assigned.from, assigned.to);
      const now = stmt(ctx.db, 'SELECT priority, severity FROM cards WHERE id = ?').get(id) as { priority: Priority | null; severity: Severity | null };
      if (now.priority !== card.priority || now.severity !== card.severity) {
        ctx.emit?.({ type: 'card_raised', cardId: id, from: { priority: card.priority, severity: card.severity }, to: now, actor: ctx.actor });
      }
    }
    return changedCard(ctx, id);
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
      return { card: getCardTile(ctx, id), orders: visibleOrders(ctx, { [String(target.id)]: visibleIdsInColumn(ctx, target.id) }) };
    }

    const targetIds = visibleIdsInColumn(ctx, target.id).filter((cid) => cid !== id);
    let index = 0;
    if (input.afterCardId !== null) {
      // A card the person can't see is no anchor (the same answer as a card that isn't there).
      const i = visibleIds(ctx, [input.afterCardId]).has(input.afterCardId) ? targetIds.indexOf(input.afterCardId) : -1;
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
      if (from.role === 'done' && target.role !== 'done') {
        completedAt = null;
        // Reopened: the old resolution no longer applies (it stays in the history).
        if (card.resolution !== null || card.resolution_md !== '') {
          stmt(ctx.db, "UPDATE cards SET resolution = NULL, resolution_md = '' WHERE id = ?").run(id);
        }
      }
      stmt(ctx.db, 'UPDATE cards SET column_id = ?, completed_at = ?, updated_at = ? WHERE id = ?').run(
        target.id,
        completedAt,
        now,
        id,
      );
      const sourceIds = visibleIdsInColumn(ctx, from.id);
      writePositions(ctx, sourceIds);
      orders[String(from.id)] = sourceIds;
      const movedId = recordEvent(ctx, id, 'moved', { from: columnRef(from), to: columnRef(target) });
      notifyMoved(ctx, id, movedId, {
        to: target.name,
        done: target.role === 'done' && from.role !== 'done',
        reopened: from.role === 'done' && target.role !== 'done',
      });
      // Reopening a finished card makes the cards it blocks blocked again.
      if (from.role === 'done' && target.role !== 'done') parkCardsBlockedBy(ctx, id);
    }
    writePositions(ctx, targetIds);
    orders[String(target.id)] = targetIds;
    return { card: getCardTile(ctx, id), orders: visibleOrders(ctx, orders) };
  });
}

/**
 * Moves several cards as one block (a folder's tickets) to `toColumnId`, in the given order, the
 * first directly after `afterCardId` (null = top). One transaction, so all of them move or none
 * do. The checks run first, on every card, so the answer doesn't depend on the order: a card
 * blocked by another card in the block is still blocked, as it would be if moved on its own.
 */
export function moveCards(
  ctx: Ctx,
  ids: number[],
  input: { toColumnId: number; afterCardId: number | null },
): MoveCardsResponse {
  return tx(ctx, () => {
    const target = targetColumn(ctx, input.toColumnId);
    const cards = ids.map((id) => getCardRow(ctx, id));
    for (const card of cards) {
      if (card.deleted_at) throw conflict('card_deleted', `“${card.title}” is in the Trash.`);
      if (card.archived_at) throw conflict('card_archived', `“${card.title}” was archived.`);
      if (target.role === 'done' && card.column_id !== target.id) assertNotBlocked(ctx, card);
    }

    let after = input.afterCardId;
    for (const card of cards) {
      moveCard(ctx, card.id, { toColumnId: target.id, afterCardId: after });
      after = card.id;
    }

    // Read once everything has moved: each single move only knows the order at its own step.
    const orders: Record<string, number[]> = {};
    for (const columnId of new Set([target.id, ...cards.map((c) => c.column_id)])) {
      orders[String(columnId)] = visibleIdsInColumn(ctx, columnId);
    }
    return { cards: ids.map((id) => getCardTile(ctx, id)), orders: visibleOrders(ctx, orders) };
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
  opts: { includeChildren: boolean; resolution?: { reason: string; note: string } },
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
            `SELECT * FROM cards c WHERE c.parent_id = ? AND c.deleted_at IS NULL AND c.archived_at IS NULL AND c.completed_at IS NULL
                AND ${visibleSql(ctx)}
              ORDER BY c.position, c.id`,
          ).all(id) as CardRow[])
        : [];
    // Children first, the work card last, so it ends up on top of Done.
    const targets = [...children, ...(card.completed_at ? [] : [card])];
    const ids = new Set(targets.map((c) => c.id));

    const stuck = targets
      .map((c) => ({ id: c.id, ticketNo: c.ticket_no, title: c.title, blockers: openBlockers(ctx, c.id).filter((b) => !ids.has(b.id)) }))
      .filter((s) => s.blockers.length);
    if (stuck.length) {
      // Blockers the person can't see still block, but aren't named.
      const seen = visibleIds(ctx, stuck.flatMap((s) => s.blockers.map((b) => b.id)));
      for (const s of stuck) s.blockers = s.blockers.filter((b) => seen.has(b.id));
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
    if (opts.resolution) {
      for (const t of targets) setResolution(ctx, getCardRow(ctx, t.id), opts.resolution);
    }
    return { card: getCard(ctx, id), orders: visibleOrders(ctx, orders), completed: targets.map((t) => t.id) };
  });
}

/**
 * Moves a card that has open blockers to the bottom of the blocked column (see getBlockedColumnId).
 * Done, archived and trashed cards stay put, as do cards already there. Returns whether it moved.
 */
export function parkIfBlocked(ctx: Ctx, id: number): boolean {
  // A knock-on change: the blocked card may be one the acting person can't see.
  const card = rawCardRow(ctx, id);
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
  const movedId = recordEvent(ctx, id, 'moved', { from: columnRef(from), to: columnRef(target), reason: 'blocked', blockedBy: blockers });
  notifyMoved(ctx, id, movedId, { to: target.name, blocked: true });
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
  assertUnrestricted(ctx, 'archive every card in Done');
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
  assertUnrestricted(ctx, 'sort a whole column');
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

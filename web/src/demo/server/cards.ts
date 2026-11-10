// Mirrors server/src/services/cards.ts: the board, creating, editing, moving, completing,
// archiving and trashing cards.

import {
  PRIORITIES,
  SEVERITIES,
  type BoardResponse,
  type CardDetail,
  type CardKind,
  type CardSource,
  type CardTile,
  type MoveCardResponse,
  type MoveCardsResponse,
  type Priority,
  type Severity,
} from '@tt/shared';
import { columnRef, labelRef, recordEvent } from './activity';
import {
  assertNotBlocked,
  cardSummary,
  findCard,
  listChecklists,
  listChildren,
  listLinks,
  openBlockers,
} from './cardParts';
import { findColumn, getBlockedColumnId, getColumnRow, getRoleColumn, listColumns } from './columns';
import { byPosition, nextId, nowIso, type CardRow, type ColumnRow, type Ctx, type UserRow } from './db';
import { badRequest, conflict, notFound } from './errors';
import { labelIdsOf, listLabels, resolveLabels } from './labels';
import { localDateOf } from './lib';
import { getResolutionReasons } from './settings';

const visible = (c: CardRow) => !c.deletedAt && !c.archivedAt;

export function toTile(ctx: Ctx, c: CardRow): CardTile {
  const items = ctx.s.checklistItems.filter((i) => ctx.s.checklists.some((l) => l.id === i.checklistId && l.cardId === c.id));
  const parent = c.parentId !== null ? findCard(ctx, c.parentId) : undefined;
  const children = ctx.s.cards.filter((k) => k.parentId === c.id && !k.deletedAt);
  return {
    id: c.id,
    ticketNo: c.ticketNo,
    kind: c.kind,
    parentId: parent && !parent.deletedAt && !parent.archivedAt ? parent.id : null,
    childCount: children.length,
    childOpen: children.filter((k) => !k.completedAt).length,
    resolution: c.resolution,
    columnId: c.columnId,
    title: c.title,
    position: c.position,
    priority: c.priority,
    severity: c.severity,
    dueDate: c.dueDate,
    dueTime: c.dueTime,
    completedAt: c.completedAt,
    labelIds: labelIdsOf(ctx, c.labelIds),
    // Attachments need server-side file storage, so the demo never has any.
    attachmentCount: 0,
    linkCount: ctx.s.links.filter((k) => {
      if (k.fromCardId !== c.id && k.toCardId !== c.id) return false;
      const other = findCard(ctx, k.fromCardId === c.id ? k.toCardId : k.fromCardId);
      return Boolean(other && !other.deletedAt);
    }).length,
    checklistDone: items.filter((i) => i.state === 'done' || i.state === 'failed').length,
    checklistTotal: items.length,
    checklistFailed: items.filter((i) => i.state === 'failed').length,
    checklistUnverified: items.filter((i) => i.state === 'unverified').length,
    blockedBy: openBlockers(ctx, c.id).length,
    assigneeId: c.assigneeId,
    version: c.version,
  };
}

function toDetail(ctx: Ctx, c: CardRow): CardDetail {
  const parent = c.parentId !== null ? cardSummary(ctx, c.parentId) : null;
  return {
    ...toTile(ctx, c),
    description: c.descriptionMd,
    archivedAt: c.archivedAt,
    deletedAt: c.deletedAt,
    source: c.source,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    checklists: listChecklists(ctx, c.id),
    attachments: [],
    links: listLinks(ctx, c.id),
    parent: parent && !parent.deletedAt ? parent : null,
    children: c.kind === 'work' ? listChildren(ctx, c.id) : [],
    resolutionNote: c.resolutionMd,
  };
}

export function getCardRow(ctx: Ctx, id: number): CardRow {
  const row = findCard(ctx, id);
  if (!row) throw notFound('Card not found');
  return row;
}

export function getCard(ctx: Ctx, id: number): CardDetail {
  return toDetail(ctx, getCardRow(ctx, id));
}

export function getCardTile(ctx: Ctx, id: number): CardTile {
  return toTile(ctx, getCardRow(ctx, id));
}

/** Marks a card as changed (updated_at) for edits that live in other tables. */
export function touchCard(ctx: Ctx, id: number): void {
  const c = findCard(ctx, id);
  if (c) c.updatedAt = nowIso(ctx);
}

/** Cards in the Trash are read-only until restored. */
export function getEditableCard(ctx: Ctx, id: number): CardRow {
  const card = getCardRow(ctx, id);
  if (card.deletedAt) throw conflict('card_deleted', 'This card is in the Trash; restore it before editing');
  return card;
}

export function getBoard(ctx: Ctx): BoardResponse {
  const colPos = new Map(ctx.s.columns.map((c) => [c.id, c.position]));
  const cards = ctx.s.cards
    .filter((c) => visible(c) && colPos.has(c.columnId))
    .sort((a, b) => colPos.get(a.columnId)! - colPos.get(b.columnId)! || byPosition(a, b));
  return {
    columns: listColumns(ctx),
    labels: listLabels(ctx),
    cards: cards.map((c) => toTile(ctx, c)),
    blockedColumnId: getBlockedColumnId(ctx),
    resolutionReasons: getResolutionReasons(ctx),
  };
}

function visibleIdsInColumn(ctx: Ctx, columnId: number): number[] {
  return ctx.s.cards
    .filter((c) => c.columnId === columnId && visible(c))
    .sort(byPosition)
    .map((c) => c.id);
}

function writePositions(ctx: Ctx, ids: number[]): void {
  ids.forEach((id, i) => {
    const c = findCard(ctx, id);
    if (c) c.position = i;
  });
}

function bottomPosition(ctx: Ctx, columnId: number): number {
  return Math.max(-1, ...ctx.s.cards.filter((c) => c.columnId === columnId && visible(c)).map((c) => c.position)) + 1;
}

/** A column named in a request body. Missing = the client's board is stale: 400, not 404. */
function targetColumn(ctx: Ctx, id: number): ColumnRow {
  const row = findColumn(ctx, id);
  if (!row) throw badRequest('invalid_target', 'That column no longer exists; refresh the board and try again');
  return row;
}

function setResolution(ctx: Ctx, card: CardRow, res: { reason: string; note: string } | null): void {
  const reason = res?.reason.trim() ?? null;
  const note = res?.note.trim() ?? '';
  if (reason === card.resolution && note === card.resolutionMd) return;
  const from = card.resolution;
  card.resolution = reason;
  card.resolutionMd = note;
  card.version += 1;
  card.updatedAt = nowIso(ctx);
  recordEvent(ctx, card.id, 'resolved', { reason, note, from });
}

/** setResolution for other services (import): the card must already be done. */
export function resolveCard(ctx: Ctx, id: number, res: { reason: string; note: string }): void {
  const row = getCardRow(ctx, id);
  if (row.completedAt) setResolution(ctx, row, res);
}

function familyRef(card: { id: number; ticketNo: string | null; title: string }) {
  return { id: card.id, ticketNo: card.ticketNo, title: card.title };
}

function checkFamily(ctx: Ctx, kind: CardKind, parentId: number | null, selfId: number | null): CardRow | null {
  if (parentId === null) return null;
  if (kind === 'work') throw badRequest('invalid_parent', "A work card can't be part of another card");
  if (parentId === selfId) throw badRequest('invalid_parent', "A card can't be part of itself");
  const parent = findCard(ctx, parentId);
  if (!parent || parent.deletedAt) throw badRequest('invalid_parent', 'That work card no longer exists');
  if (parent.kind !== 'work') throw badRequest('invalid_parent', 'Tickets can only be filed under a work card');
  return parent;
}

const openChildCount = (ctx: Ctx, id: number) => ctx.s.cards.filter((c) => c.parentId === id && !c.deletedAt).length;

// ---------------------------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------------------------

/** Allowed clock skew for "not in the future" checks. */
export const FUTURE_SLACK_MS = 5 * 60 * 1000;

export interface CreateCardInput {
  title: string;
  description?: string;
  columnId?: number;
  labelIds?: number[];
  labelNames?: string[];
  priority?: Priority | null;
  severity?: Severity | null;
  dueDate?: string | null;
  dueTime?: string | null;
  position?: 'top' | 'bottom';
  checklists?: { title: string; items: string[] }[];
  kind?: CardKind;
  parentId?: number | null;
  assigneeId?: number | null;
}

export interface CreateCardOptions {
  source?: CardSource;
  sourceRef?: string | null;
  templateId?: number | null;
  templateTitle?: string;
  via?: string;
}

/** Someone a card can be given to: an existing, active person (400 invalid_assignee / assignee_disabled). */
function checkAssignee(ctx: Ctx, userId: number): UserRow {
  const user = ctx.s.users.find((u) => u.id === userId);
  if (!user) throw badRequest('invalid_assignee', 'That person doesn’t exist (anymore); reload and pick again');
  if (user.disabledAt) throw badRequest('assignee_disabled', `${user.displayName} is deactivated and can’t be assigned cards`);
  return user;
}

function recordAssigned(ctx: Ctx, cardId: number, from: number | null, to: UserRow | null): void {
  const fromName = from !== null ? (ctx.s.users.find((u) => u.id === from)?.displayName ?? null) : null;
  recordEvent(ctx, cardId, 'assigned', { from, to: to?.id ?? null, fromName, toName: to?.displayName ?? null });
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

export function nextTicketNo(ctx: Ctx, at: Date): string {
  const prefix = ticketPrefix(ctx.s.settings.general.ticketFormat, localDateOf(at, ctx.tz));
  const max = ctx.s.cards.reduce((m, c) => {
    if (!c.ticketNo?.startsWith(prefix)) return m;
    const n = c.ticketNo.slice(prefix.length);
    return /^\d+$/.test(n) ? Math.max(m, Number(n)) : m;
  }, 0);
  return `${prefix}${max + 1}`;
}

export function createCard(ctx: Ctx, input: CreateCardInput, opts: CreateCardOptions = {}): CardDetail {
  const title = input.title.trim();
  if (!title) throw badRequest('validation', 'Title is required');
  if (input.dueTime && !input.dueDate) throw badRequest('validation', 'dueTime requires dueDate');

  const kind = input.kind ?? 'ticket';
  const parent = checkFamily(ctx, kind, input.parentId ?? null, null);
  const assignee = input.assigneeId != null ? checkAssignee(ctx, input.assigneeId) : null;
  const column = input.columnId !== undefined ? targetColumn(ctx, input.columnId) : getRoleColumn(ctx, 'triage');
  const labels = resolveLabels(ctx, input.labelIds, input.labelNames);
  const now = nowIso(ctx);

  let position: number;
  if (input.position === 'top') {
    for (const c of ctx.s.cards) if (c.columnId === column.id && visible(c)) c.position += 1;
    position = 0;
  } else {
    position = bottomPosition(ctx, column.id);
  }

  const ticketNo = nextTicketNo(ctx, ctx.now());
  const id = nextId(ctx, 'cards');
  ctx.s.cards.push({
    id,
    columnId: column.id,
    title,
    descriptionMd: input.description ?? '',
    priority: input.priority ?? null,
    severity: input.severity ?? null,
    dueDate: input.dueDate ?? null,
    dueTime: input.dueDate ? (input.dueTime ?? null) : null,
    position,
    version: 0,
    completedAt: column.role === 'done' ? now : null,
    archivedAt: null,
    deletedAt: null,
    source: opts.source ?? 'manual',
    sourceRef: opts.sourceRef ?? null,
    templateId: opts.templateId ?? null,
    ticketNo,
    kind,
    parentId: parent?.id ?? null,
    resolution: null,
    resolutionMd: '',
    assigneeId: assignee?.id ?? null,
    createdAt: now,
    updatedAt: now,
    labelIds: labels.map((l) => l.id),
  });

  input.checklists?.forEach((cl, i) => {
    const listId = nextId(ctx, 'checklists');
    ctx.s.checklists.push({ id: listId, cardId: id, title: cl.title, position: i, createdAt: now });
    cl.items.forEach((text, j) =>
      ctx.s.checklistItems.push({
        id: nextId(ctx, 'checklistItems'),
        checklistId: listId,
        text,
        state: 'open',
        checkedAt: null,
        position: j,
        createdAt: now,
      }),
    );
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
  if (assignee) recordAssigned(ctx, id, null, assignee);
  return getCard(ctx, id);
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
  assigneeId?: number | null;
  resolution?: { reason: string; note: string } | null;
}

/** Applies the changed fields, logging one event per field. Version bumps only on a real change. */
export function updateCard(ctx: Ctx, id: number, patch: UpdateCardInput): CardDetail {
  const card = getEditableCard(ctx, id);
  if (patch.expectedVersion !== undefined && patch.expectedVersion !== card.version) {
    throw conflict('version_conflict', 'This card was changed somewhere else', { card: getCard(ctx, id) });
  }
  const next: Partial<CardRow> = {};
  let changed = false;

  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) throw badRequest('validation', 'Title is required');
    if (title !== card.title) {
      next.title = title;
      recordEvent(ctx, id, 'title_changed', { from: card.title, to: title });
    }
  }

  if (patch.description !== undefined && patch.description !== card.descriptionMd) {
    next.descriptionMd = patch.description;
    recordEvent(ctx, id, 'description_changed', { from: card.descriptionMd, to: patch.description });
  }

  if (patch.priority !== undefined && patch.priority !== card.priority) {
    next.priority = patch.priority;
    recordEvent(ctx, id, 'priority_changed', { from: card.priority, to: patch.priority });
  }

  if (patch.severity !== undefined && patch.severity !== card.severity) {
    next.severity = patch.severity;
    recordEvent(ctx, id, 'severity_changed', { from: card.severity, to: patch.severity });
  }

  if (patch.dueDate !== undefined || patch.dueTime !== undefined) {
    const date = patch.dueDate !== undefined ? patch.dueDate : card.dueDate;
    let time = patch.dueTime !== undefined ? patch.dueTime : card.dueTime;
    if (!date) time = null;
    if (patch.dueTime && !date) throw badRequest('validation', 'dueTime requires dueDate');
    if (date !== card.dueDate || time !== card.dueTime) {
      next.dueDate = date;
      next.dueTime = time;
      recordEvent(ctx, id, 'due_changed', {
        from: card.dueDate ? { date: card.dueDate, time: card.dueTime } : null,
        to: date ? { date, time } : null,
      });
    }
  }

  if (patch.labelIds !== undefined) {
    const current = resolveLabels(ctx, labelIdsOf(ctx, card.labelIds));
    const wanted = resolveLabels(ctx, patch.labelIds);
    const added = wanted.filter((l) => !card.labelIds.includes(l.id));
    const removed = current.filter((l) => !wanted.some((w) => w.id === l.id));
    if (added.length || removed.length) {
      card.labelIds = [...card.labelIds.filter((l) => !removed.some((r) => r.id === l)), ...added.map((l) => l.id)];
      recordEvent(ctx, id, 'labels_changed', { added: added.map(labelRef), removed: removed.map(labelRef) });
      changed = true;
    }
  }

  // Type and "part of": validated together, since changing one can make the other invalid.
  const kind = patch.kind ?? card.kind;
  const parentId = patch.parentId !== undefined ? patch.parentId : card.parentId;
  if (kind !== card.kind || parentId !== card.parentId) {
    if (kind === 'ticket' && card.kind === 'work') {
      const n = openChildCount(ctx, id);
      if (n) {
        throw badRequest(
          'invalid_parent',
          `This work card still has ${n} ticket${n === 1 ? '' : 's'}; move ${n === 1 ? 'it' : 'them'} out first`,
        );
      }
    }
    if (kind === 'work' && parentId !== null && patch.parentId === undefined) {
      throw badRequest('invalid_parent', 'Take this ticket out of its work card before making it a work card');
    }
    const parent = checkFamily(ctx, kind, parentId, id);
    if (kind !== card.kind) {
      next.kind = kind;
      recordEvent(ctx, id, 'kind_changed', { from: card.kind, to: kind });
    }
    if (parentId !== card.parentId) {
      const old = card.parentId !== null ? (findCard(ctx, card.parentId) ?? null) : null;
      next.parentId = parentId;
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
  if (patch.assigneeId !== undefined && patch.assigneeId !== card.assigneeId) {
    const to = patch.assigneeId !== null ? checkAssignee(ctx, patch.assigneeId) : null;
    next.assigneeId = to?.id ?? null;
    recordAssigned(ctx, id, card.assigneeId, to);
  }

  if (patch.resolution !== undefined) {
    if (!card.completedAt) throw conflict('not_done', 'Only a done card has a resolution');
    setResolution(ctx, card, patch.resolution);
  }

  if (patch.completedAt !== undefined && patch.completedAt !== card.completedAt) {
    if (!card.completedAt) {
      throw conflict('not_done', 'Only a completed card (in the Done column) has a completion date');
    }
    if (Date.parse(patch.completedAt) > ctx.now().getTime() + FUTURE_SLACK_MS) {
      throw badRequest('validation', "The completion date can't be in the future");
    }
    next.completedAt = patch.completedAt;
    recordEvent(ctx, id, 'completion_changed', { from: card.completedAt, to: patch.completedAt });
  }

  if (Object.keys(next).length || changed) {
    Object.assign(card, next);
    // On top of setResolution's own bump above, like the server's two UPDATEs.
    card.version += 1;
    card.updatedAt = nowIso(ctx);
  }
  return getCard(ctx, id);
}

// ---------------------------------------------------------------------------------------------
// Moving
// ---------------------------------------------------------------------------------------------

/** Moves a card to `toColumnId`, directly after `afterCardId` (null = top). */
export function moveCard(
  ctx: Ctx,
  id: number,
  input: { toColumnId: number; afterCardId: number | null },
  opts: { skipBlockCheck?: boolean } = {},
): MoveCardResponse {
  const card = getEditableCard(ctx, id);
  if (card.archivedAt) throw conflict('card_archived', 'Restore this card from the archive before moving it');
  const target = targetColumn(ctx, input.toColumnId);

  if (input.afterCardId === id && card.columnId === target.id) {
    return { card: getCardTile(ctx, id), orders: { [String(target.id)]: visibleIdsInColumn(ctx, target.id) } };
  }

  const targetIds = visibleIdsInColumn(ctx, target.id).filter((cid) => cid !== id);
  let index = 0;
  if (input.afterCardId !== null) {
    const i = targetIds.indexOf(input.afterCardId);
    if (i < 0) throw badRequest('anchor_not_found', 'That position no longer exists; refresh the board and try again');
    index = i + 1;
  }
  targetIds.splice(index, 0, id);

  const orders: Record<string, number[]> = {};
  if (card.columnId !== target.id) {
    const from = getColumnRow(ctx, card.columnId);
    const now = nowIso(ctx);
    let completedAt = card.completedAt;
    if (target.role === 'done' && from.role !== 'done') {
      if (!opts.skipBlockCheck) assertNotBlocked(ctx, card);
      completedAt = now;
    }
    if (from.role === 'done' && target.role !== 'done') {
      completedAt = null;
      // Reopened: the old resolution no longer applies (it stays in the history).
      card.resolution = null;
      card.resolutionMd = '';
    }
    card.columnId = target.id;
    card.completedAt = completedAt;
    card.updatedAt = now;
    const sourceIds = visibleIdsInColumn(ctx, from.id);
    writePositions(ctx, sourceIds);
    orders[String(from.id)] = sourceIds;
    recordEvent(ctx, id, 'moved', { from: columnRef(from), to: columnRef(target) });
    if (from.role === 'done' && target.role !== 'done') parkCardsBlockedBy(ctx, id);
  }
  writePositions(ctx, targetIds);
  orders[String(target.id)] = targetIds;
  return { card: getCardTile(ctx, id), orders };
}

/** Moves several cards as one block, in the given order. All of them move or none do. */
export function moveCards(ctx: Ctx, ids: number[], input: { toColumnId: number; afterCardId: number | null }): MoveCardsResponse {
  const target = targetColumn(ctx, input.toColumnId);
  const cards = ids.map((id) => getCardRow(ctx, id));
  for (const card of cards) {
    if (card.deletedAt) throw conflict('card_deleted', `“${card.title}” is in the Trash.`);
    if (card.archivedAt) throw conflict('card_archived', `“${card.title}” was archived.`);
    if (target.role === 'done' && card.columnId !== target.id) assertNotBlocked(ctx, card);
  }
  const startColumns = cards.map((c) => c.columnId);

  let after = input.afterCardId;
  for (const card of cards) {
    moveCard(ctx, card.id, { toColumnId: target.id, afterCardId: after });
    after = card.id;
  }

  const orders: Record<string, number[]> = {};
  for (const columnId of new Set([target.id, ...startColumns])) orders[String(columnId)] = visibleIdsInColumn(ctx, columnId);
  return { cards: ids.map((id) => getCardTile(ctx, id)), orders };
}

/** Mark done, optionally with every open ticket filed under a work card. All or nothing. */
export function completeCard(
  ctx: Ctx,
  id: number,
  opts: { includeChildren: boolean; resolution?: { reason: string; note: string } },
): { card: CardDetail; orders: Record<string, number[]>; completed: number[] } {
  const card = getEditableCard(ctx, id);
  if (card.archivedAt) throw conflict('card_archived', 'Restore this card from the archive first');
  const done = getRoleColumn(ctx, 'done');
  const children =
    opts.includeChildren && card.kind === 'work'
      ? ctx.s.cards.filter((c) => c.parentId === id && !c.deletedAt && !c.archivedAt && !c.completedAt).sort(byPosition)
      : [];
  const targets = [...children, ...(card.completedAt ? [] : [card])];
  const ids = new Set(targets.map((c) => c.id));

  const stuck = targets
    .map((c) => ({ id: c.id, ticketNo: c.ticketNo, title: c.title, blockers: openBlockers(ctx, c.id).filter((b) => !ids.has(b.id)) }))
    .filter((s) => s.blockers.length);
  if (stuck.length) {
    const names = stuck
      .slice(0, 3)
      .map((s) => `“${s.title}”`)
      .join(', ');
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
  return { card: getCard(ctx, id), orders, completed: targets.map((t) => t.id) };
}

/** Moves a card with open blockers to the bottom of the blocked column. Returns whether it moved. */
export function parkIfBlocked(ctx: Ctx, id: number): boolean {
  const card = getCardRow(ctx, id);
  if (card.deletedAt || card.archivedAt || card.completedAt) return false;
  const targetId = getBlockedColumnId(ctx);
  if (targetId === null || card.columnId === targetId) return false;
  const blockers = openBlockers(ctx, id);
  if (!blockers.length) return false;

  const from = getColumnRow(ctx, card.columnId);
  const target = getColumnRow(ctx, targetId);
  card.columnId = target.id;
  card.updatedAt = nowIso(ctx);
  writePositions(ctx, visibleIdsInColumn(ctx, from.id));
  writePositions(ctx, [...visibleIdsInColumn(ctx, target.id).filter((cid) => cid !== id), id]);
  recordEvent(ctx, id, 'moved', { from: columnRef(from), to: columnRef(target), reason: 'blocked', blockedBy: blockers });
  return true;
}

export function parkCardsBlockedBy(ctx: Ctx, blockerId: number): void {
  for (const k of ctx.s.links.filter((l) => l.fromCardId === blockerId && l.type === 'blocks')) parkIfBlocked(ctx, k.toCardId);
}

// ---------------------------------------------------------------------------------------------
// Trash and archive
// ---------------------------------------------------------------------------------------------

export function deleteCard(ctx: Ctx, id: number): void {
  const card = getCardRow(ctx, id);
  if (card.deletedAt) return;
  const now = nowIso(ctx);
  card.deletedAt = now;
  card.updatedAt = now;
  recordEvent(ctx, id, 'deleted', { column: columnRef(getColumnRow(ctx, card.columnId)) });
}

export function undeleteCard(ctx: Ctx, id: number): CardDetail {
  const card = getCardRow(ctx, id);
  if (!card.deletedAt) return getCard(ctx, id);
  const pos = card.archivedAt ? card.position : bottomPosition(ctx, card.columnId);
  card.deletedAt = null;
  card.position = pos;
  card.updatedAt = nowIso(ctx);
  recordEvent(ctx, id, 'undeleted', { column: columnRef(getColumnRow(ctx, card.columnId)) });
  parkCardsBlockedBy(ctx, id);
  return getCard(ctx, id);
}

export function archiveCard(ctx: Ctx, id: number): CardDetail {
  const card = getEditableCard(ctx, id);
  if (card.archivedAt) return getCard(ctx, id);
  const column = getColumnRow(ctx, card.columnId);
  if (column.role !== 'done') throw conflict('not_done', 'Only cards in the Done column can be archived');
  const now = nowIso(ctx);
  card.archivedAt = now;
  card.updatedAt = now;
  writePositions(ctx, visibleIdsInColumn(ctx, column.id));
  recordEvent(ctx, id, 'archived', { column: columnRef(column) });
  return getCard(ctx, id);
}

export function restoreCard(ctx: Ctx, id: number): CardDetail {
  const card = getEditableCard(ctx, id);
  if (!card.archivedAt) return getCard(ctx, id);
  card.position = bottomPosition(ctx, card.columnId);
  card.archivedAt = null;
  card.updatedAt = nowIso(ctx);
  recordEvent(ctx, id, 'restored', { column: columnRef(getColumnRow(ctx, card.columnId)) });
  return getCard(ctx, id);
}

export function archiveAllDone(ctx: Ctx): number {
  const done = getRoleColumn(ctx, 'done');
  const ids = visibleIdsInColumn(ctx, done.id);
  for (const id of ids) archiveCard(ctx, id);
  return ids.length;
}

const rank = <T extends string>(order: readonly T[], v: T | null) => (v === null ? order.length : order.indexOf(v));

/** One-off "Sort by priority": P0 → P3, then S1 → S4; ties keep their order. */
export function sortColumnByPriority(ctx: Ctx, columnId: number): Record<string, number[]> {
  getColumnRow(ctx, columnId);
  const rows = ctx.s.cards.filter((c) => c.columnId === columnId && visible(c)).sort(byPosition);
  const sorted = rows
    .map((r, i) => ({ r, i }))
    .sort(
      (a, b) =>
        rank(PRIORITIES, a.r.priority) - rank(PRIORITIES, b.r.priority) ||
        rank(SEVERITIES, a.r.severity) - rank(SEVERITIES, b.r.severity) ||
        a.i - b.i,
    )
    .map((x) => x.r.id);
  writePositions(ctx, sorted);
  return { [String(columnId)]: sorted };
}

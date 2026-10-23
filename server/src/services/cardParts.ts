// Read-only helpers for the parts of a card shown in its detail view (checklists, attachments,
// links) and for card summaries in lists. Kept apart from cards.ts so the services that change
// these parts can import cards.ts without a cycle.

import type {
  Attachment,
  AttachmentKind,
  CardLink,
  CardSummary,
  Checklist,
  ChecklistItem,
  LinkDirection,
} from '@tt/shared';
import { stmt } from '../db/connection';
import type { Ctx } from './context';

export interface ChecklistRow {
  id: number;
  card_id: number;
  title: string;
  position: number;
  created_at: string;
}

export interface ChecklistItemRow {
  id: number;
  checklist_id: number;
  text: string;
  checked: 0 | 1;
  checked_at: string | null;
  position: number;
  created_at: string;
}

export interface AttachmentRow {
  id: number;
  card_id: number;
  original_name: string;
  stored_name: string;
  mime_type: string;
  kind: AttachmentKind;
  size_bytes: number;
  sha256: string;
  created_at: string;
}

export interface LinkRow {
  id: number;
  from_card_id: number;
  to_card_id: number;
  type: 'relates' | 'blocks';
  created_at: string;
}

const toItem = (r: ChecklistItemRow): ChecklistItem => ({
  id: r.id,
  text: r.text,
  checked: r.checked === 1,
  checkedAt: r.checked_at,
  position: r.position,
});

export function listChecklists(ctx: Ctx, cardId: number): Checklist[] {
  const lists = stmt(ctx.db, 'SELECT * FROM checklists WHERE card_id = ? ORDER BY position, id').all(
    cardId,
  ) as ChecklistRow[];
  if (!lists.length) return [];
  const items = stmt(
    ctx.db,
    `SELECT i.* FROM checklist_items i JOIN checklists c ON c.id = i.checklist_id
      WHERE c.card_id = ? ORDER BY i.position, i.id`,
  ).all(cardId) as ChecklistItemRow[];
  return lists.map((l) => ({
    id: l.id,
    title: l.title,
    position: l.position,
    items: items.filter((i) => i.checklist_id === l.id).map(toItem),
  }));
}

export const toAttachment = (r: AttachmentRow): Attachment => ({
  id: r.id,
  name: r.original_name,
  mimeType: r.mime_type,
  kind: r.kind,
  sizeBytes: r.size_bytes,
  createdAt: r.created_at,
});

export function listAttachments(ctx: Ctx, cardId: number): Attachment[] {
  return (
    stmt(ctx.db, 'SELECT * FROM attachments WHERE card_id = ? ORDER BY created_at, id').all(cardId) as AttachmentRow[]
  ).map(toAttachment);
}

const SUMMARY_SELECT = `
SELECT c.id, c.title, c.column_id, col.name AS column_name, c.completed_at, c.archived_at, c.deleted_at,
       c.updated_at,
       (SELECT group_concat(cl.label_id, ',' ORDER BY l.position, l.id)
          FROM card_labels cl JOIN labels l ON l.id = cl.label_id WHERE cl.card_id = c.id) AS label_ids
  FROM cards c JOIN columns col ON col.id = c.column_id`;

interface SummaryRow {
  id: number;
  title: string;
  column_id: number;
  column_name: string;
  completed_at: string | null;
  archived_at: string | null;
  deleted_at: string | null;
  updated_at: string;
  label_ids: string | null;
}

const toSummary = (r: SummaryRow): CardSummary => ({
  id: r.id,
  title: r.title,
  columnId: r.column_id,
  columnName: r.column_name,
  labelIds: r.label_ids ? r.label_ids.split(',').map(Number) : [],
  completedAt: r.completed_at,
  archivedAt: r.archived_at,
  deletedAt: r.deleted_at,
  updatedAt: r.updated_at,
});

export function cardSummary(ctx: Ctx, id: number): CardSummary | null {
  const row = stmt(ctx.db, `${SUMMARY_SELECT} WHERE c.id = ?`).get(id) as SummaryRow | undefined;
  return row ? toSummary(row) : null;
}

export type CardListStatus = 'board' | 'archived' | 'trashed' | 'live';

const STATUS_WHERE: Record<CardListStatus, string> = {
  board: 'c.deleted_at IS NULL AND c.archived_at IS NULL',
  archived: 'c.deleted_at IS NULL AND c.archived_at IS NOT NULL',
  trashed: 'c.deleted_at IS NOT NULL',
  live: 'c.deleted_at IS NULL',
};

const STATUS_ORDER: Record<CardListStatus, string> = {
  board: 'c.updated_at DESC',
  archived: 'c.archived_at DESC',
  trashed: 'c.deleted_at DESC',
  live: 'c.updated_at DESC',
};

/** Card lists for the link picker, Archive and Trash. `q` matches titles (case-insensitive). */
export function listCards(ctx: Ctx, opts: { status: CardListStatus; q?: string; limit: number }): CardSummary[] {
  const where = [STATUS_WHERE[opts.status]];
  const params: unknown[] = [];
  const q = opts.q?.trim();
  if (q) {
    // A bare number also finds the card with that id ("#12" or "12").
    const n = Number(q.replace(/^#/, ''));
    if (Number.isInteger(n) && n > 0) {
      where.push(`(c.title LIKE ? ESCAPE '\\' OR c.id = ?)`);
      params.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`, n);
    } else {
      where.push(`c.title LIKE ? ESCAPE '\\'`);
      params.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`);
    }
  }
  const sql = `${SUMMARY_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${STATUS_ORDER[opts.status]}, c.id DESC LIMIT ?`;
  return (ctx.db.prepare(sql).all(...params, opts.limit) as SummaryRow[]).map(toSummary);
}

/** Links of a card to cards that aren't in the Trash, from this card's point of view. */
export function listLinks(ctx: Ctx, cardId: number): CardLink[] {
  const rows = stmt(
    ctx.db,
    'SELECT * FROM card_links WHERE from_card_id = ? OR to_card_id = ? ORDER BY created_at, id',
  ).all(cardId, cardId) as LinkRow[];
  const out: CardLink[] = [];
  for (const r of rows) {
    const otherId = r.from_card_id === cardId ? r.to_card_id : r.from_card_id;
    const other = cardSummary(ctx, otherId);
    if (!other || other.deletedAt) continue;
    out.push({ id: r.id, direction: linkDirection(r, cardId), card: other });
  }
  return out;
}

export function linkDirection(row: LinkRow, cardId: number): LinkDirection {
  if (row.type === 'relates') return 'relates';
  return row.from_card_id === cardId ? 'blocks' : 'blocked_by';
}

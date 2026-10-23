import type { ActivityEntry, ActivityEventType, ColumnRef, LabelRef } from '@tt/shared';
import { stmt } from '../db/connection';
import { nowIso, type Ctx } from './context';

interface ActivityRow {
  id: number;
  card_id: number;
  kind: 'event' | 'worklog';
  type: string;
  data: string;
  body_md: string | null;
  occurred_at: string;
  created_at: string;
  edited_at: string | null;
  retracted_at: string | null;
}

/**
 * Appends an automatic event to a card's log. Callers run inside the same transaction as the change
 * they describe, so the log can never disagree with the data. `data` should carry names (not just
 * ids) so the history still reads correctly after renames and deletes.
 */
export function recordEvent(ctx: Ctx, cardId: number, type: ActivityEventType, data: object = {}): number {
  const now = nowIso(ctx);
  const info = stmt(
    ctx.db,
    `INSERT INTO activity (card_id, kind, type, data, occurred_at, created_at) VALUES (?, 'event', ?, ?, ?, ?)`,
  ).run(cardId, type, JSON.stringify(data), now, now);
  return Number(info.lastInsertRowid);
}

export function toActivityEntry(row: ActivityRow): ActivityEntry {
  return {
    id: row.id,
    cardId: row.card_id,
    kind: row.kind,
    type: row.type as ActivityEntry['type'],
    data: JSON.parse(row.data) as Record<string, unknown>,
    bodyMd: row.body_md,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    retractedAt: row.retracted_at,
  };
}

/** Newest first, by effective time. */
export function listActivity(ctx: Ctx, cardId: number): ActivityEntry[] {
  const rows = stmt(
    ctx.db,
    'SELECT * FROM activity WHERE card_id = ? ORDER BY occurred_at DESC, id DESC',
  ).all(cardId) as ActivityRow[];
  return rows.map(toActivityEntry);
}

export function columnRef(col: { id: number; name: string; role: string | null }): ColumnRef {
  return { id: col.id, name: col.name, role: col.role as ColumnRef['role'] };
}

export function labelRef(l: { id: number; name: string; color: string }): LabelRef {
  return { id: l.id, name: l.name, color: l.color };
}

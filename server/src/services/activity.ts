import type { ActivityEntry, ActivityEventType, ColumnRef, LabelRef } from '@tt/shared';
import { stmt } from '../db/connection';
import { actorTokenId, actorUserId, nowIso, type Ctx } from './context';
import { visibleIds } from './scope';

export interface ActivityRow {
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
  user_id: number | null;
  token_id: number | null;
  revision_count?: number;
  /** From ACTIVITY_SELECT's joins: who did it, by name. */
  user_name?: string | null;
  user_username?: string | null;
  token_name?: string | null;
}

/**
 * Activity rows with their revision count and who did it by name (the person's display name and
 * the token's name). Resolved here, so members can read who did what without listing tokens.
 */
export const ACTIVITY_SELECT = `SELECT a.*, (SELECT count(*) FROM activity_revisions r WHERE r.activity_id = a.id) AS revision_count,
         u.display_name AS user_name, u.username AS user_username, t.name AS token_name
    FROM activity a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN api_tokens t ON t.id = a.token_id`;

/**
 * Appends an automatic event to a card's log. Callers run inside the same transaction as the change
 * they describe, so the log can never disagree with the data. `data` should carry names (not just
 * ids) so the history still reads correctly after renames and deletes.
 */
export function recordEvent(ctx: Ctx, cardId: number, type: ActivityEventType, data: object = {}): number {
  const now = nowIso(ctx);
  const info = stmt(
    ctx.db,
    `INSERT INTO activity (card_id, kind, type, data, occurred_at, created_at, user_id, token_id) VALUES (?, 'event', ?, ?, ?, ?, ?, ?)`,
  ).run(cardId, type, JSON.stringify(data), now, now, actorUserId(ctx), actorTokenId(ctx));
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
    revisionCount: row.revision_count ?? 0,
    userId: row.user_id ?? null,
    tokenId: row.token_id ?? null,
    userName: row.user_name ?? null,
    userUsername: row.user_username ?? null,
    tokenName: row.token_name ?? null,
  };
}

/** Newest first, by effective time. */
export function listActivity(ctx: Ctx, cardId: number): ActivityEntry[] {
  const rows = stmt(ctx.db, `${ACTIVITY_SELECT} WHERE a.card_id = ? ORDER BY a.occurred_at DESC, a.id DESC`).all(cardId) as ActivityRow[];
  const entries = rows.map(toActivityEntry);
  return ctx.scope ? hideOtherCards(ctx, entries) : entries;
}

/** What history shows instead of the title of another card a tag-restricted person can't see. */
export const HIDDEN_CARD_TITLE = 'Hidden ticket';

type Ref = { id?: unknown; title?: unknown; ticketNo?: unknown };
const isRef = (v: unknown): v is Ref => typeof v === 'object' && v !== null && 'id' in v;

/** Where each event type names other cards ({ id, title, ticketNo? } objects; `moved` has a list). */
const CARD_KEYS: Partial<Record<string, readonly string[]>> = {
  created: ['parent'],
  parent_changed: ['from', 'to'],
  child_added: ['child'],
  child_removed: ['child'],
  moved: ['blockedBy'],
};

/** The other cards an entry names: linked cards, parents, children and blockers. */
function refsOf(e: ActivityEntry): Ref[] {
  const d = e.data;
  const refs = (CARD_KEYS[e.type] ?? []).flatMap((k) => (Array.isArray(d[k]) ? (d[k] as unknown[]) : [d[k]])).filter(isRef);
  if (e.type === 'linked' || e.type === 'unlinked') refs.push({ id: d.otherId });
  return refs;
}

/**
 * Keeps every entry of a visible card, but takes out the title and ticket number of each other card
 * named in it that `ctx` can't see (leaving the entry out would misstate the card's own history).
 */
function hideOtherCards(ctx: Ctx, entries: ActivityEntry[]): ActivityEntry[] {
  const ids = entries.flatMap((e) => refsOf(e).map((r) => r.id)).filter((id): id is number => typeof id === 'number');
  const seen = visibleIds(ctx, ids);
  const hide = (r: unknown) => (isRef(r) && typeof r.id === 'number' && !seen.has(r.id) ? { ...r, title: HIDDEN_CARD_TITLE, ticketNo: null } : r);
  return entries.map((e) => {
    if (!refsOf(e).some((r) => typeof r.id !== 'number' || !seen.has(r.id))) return e;
    const d = { ...e.data };
    for (const k of CARD_KEYS[e.type] ?? []) d[k] = Array.isArray(d[k]) ? (d[k] as unknown[]).map(hide) : hide(d[k]);
    if ((e.type === 'linked' || e.type === 'unlinked') && !(typeof d.otherId === 'number' && seen.has(d.otherId))) d.otherTitle = HIDDEN_CARD_TITLE;
    return { ...e, data: d };
  });
}

export function columnRef(col: { id: number; name: string; role: string | null }): ColumnRef {
  return { id: col.id, name: col.name, role: col.role as ColumnRef['role'] };
}

export function labelRef(l: { id: number; name: string; color: string }): LabelRef {
  return { id: l.id, name: l.name, color: l.color };
}

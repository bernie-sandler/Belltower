// Tag-restricted accounts: an admin can limit a member to cards that carry at least one of the
// member's tags (users.tag_scoped + user_labels). Untagged cards are hidden from them, and a
// restricted member whose tags were all deleted sees nothing: every check here fails closed.
//
// The guard puts the restriction on the request's context (ctx.scope). Every query that reads
// cards for a person adds visibleSql(ctx, alias); a single card named by id goes through
// getCardRow (cards.ts), which answers 404 for a card the person can't see. Admins, the owner,
// unrestricted members, the system (timers, templates) and the public have no scope.

import { stmt } from '../db/connection';
import { AppError, notFound } from '../errors';
import type { Ctx, TagScope } from './context';

const ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface ScopeUserRow {
  role: string;
  is_owner: 0 | 1;
  tag_scoped: 0 | 1;
}

/**
 * A person's tags when they're restricted (label ids in tag order; empty = they see nothing), or
 * null when they see every card. Admins and the owner are never restricted, whatever is stored.
 */
export function userTagScope(ctx: Ctx, userId: number): number[] | null {
  const u = stmt(ctx.db, 'SELECT role, is_owner, tag_scoped FROM users WHERE id = ?').get(userId) as ScopeUserRow | undefined;
  if (!u || u.role === 'admin' || u.is_owner === 1 || u.tag_scoped !== 1) return null;
  return stmt(
    ctx.db,
    'SELECT ul.label_id FROM user_labels ul JOIN labels l ON l.id = ul.label_id WHERE ul.user_id = ? ORDER BY l.position, l.id',
  )
    .pluck()
    .all(userId) as number[];
}

/** What the guard puts on a request acting as `userId` (null for a token nobody owns). */
export function scopeFor(ctx: Ctx, userId: number | null): TagScope | undefined {
  if (userId === null) return undefined;
  const labelIds = userTagScope(ctx, userId);
  return labelIds ? { userId, labelIds } : undefined;
}

export function isRestricted(ctx: Ctx): boolean {
  return ctx.scope !== undefined;
}

/**
 * SQL that is true for the cards `ctx` may see, for the card table aliased `alias` ('1' when it
 * sees everything). The person's id is written into the SQL (it's an integer from the sessions or
 * tokens table, checked here), so it fits anywhere in a query, subqueries included, without
 * shifting the positional parameters around it; prepared statements are then cached per person.
 */
export function visibleSql(ctx: Ctx, alias = 'c'): string {
  return ctx.scope ? restrictedVisibleSql(ctx.scope.userId, alias) : visibleAlias(alias);
}

const visibleAlias = (alias: string) => {
  if (!ALIAS.test(alias)) throw new Error(`visibleSql: bad alias ${alias}`);
  return '1';
};

/** visibleSql for a tag-restricted person `userId` (whoever is acting). */
export function restrictedVisibleSql(userId: number, alias = 'c'): string {
  visibleAlias(alias);
  if (!Number.isSafeInteger(userId)) throw new Error('visibleSql: bad user id');
  return `EXISTS (SELECT 1 FROM card_labels scl JOIN user_labels sul ON sul.label_id = scl.label_id
                   WHERE scl.card_id = ${alias}.id AND sul.user_id = ${userId})`;
}

/** Whether `ctx` may see card `cardId` (false for a card that doesn't exist). */
export function canSeeCard(ctx: Ctx, cardId: number): boolean {
  return stmt(ctx.db, `SELECT EXISTS (SELECT 1 FROM cards c WHERE c.id = ? AND ${visibleSql(ctx)})`).pluck().get(cardId) === 1;
}

/** 404 for a card `ctx` can't see, the same answer as for a card that doesn't exist. */
export function assertCanSeeCard(ctx: Ctx, cardId: number): void {
  if (!canSeeCard(ctx, cardId)) throw notFound('Card not found');
}

/** The ids among `ids` that `ctx` may see (all of them when it isn't restricted). */
export function visibleIds(ctx: Ctx, ids: Iterable<number>): Set<number> {
  const all = [...new Set(ids)];
  if (!ctx.scope || !all.length) return new Set(all);
  const seen = stmt(
    ctx.db,
    `SELECT c.id FROM cards c WHERE c.id IN (SELECT value FROM json_each(?)) AND ${visibleSql(ctx)}`,
  )
    .pluck()
    .all(JSON.stringify(all)) as number[];
  return new Set(seen);
}

/** `orders` (column id → card ids, as move and sort answer) without the cards `ctx` can't see. */
export function visibleOrders(ctx: Ctx, orders: Record<string, number[]>): Record<string, number[]> {
  if (!ctx.scope) return orders;
  const seen = visibleIds(ctx, Object.values(orders).flat());
  return Object.fromEntries(Object.entries(orders).map(([col, ids]) => [col, ids.filter((id) => seen.has(id))]));
}

/**
 * Whether person `userId` may see card `cardId`, judged by their own account rather than the
 * request's (for assignees and notification recipients).
 */
export function userCanSeeCard(ctx: Ctx, userId: number, cardId: number): boolean {
  const labelIds = userTagScope(ctx, userId);
  if (labelIds === null) return true;
  return canSeeCard({ ...ctxView(ctx), scope: { userId, labelIds } }, cardId);
}

/** A plain view of ctx's database for one-off scoped checks (never copies a getter-backed handle into storage). */
function ctxView(ctx: Ctx): Ctx {
  return { db: ctx.db, clock: ctx.clock, tz: ctx.tz };
}

/** 403 `restricted`: board-wide changes a tag-restricted member can't make. */
export function assertUnrestricted(ctx: Ctx, what: string): void {
  if (ctx.scope) {
    throw new AppError(403, 'restricted', `Your account only sees some tags, so you can’t ${what}. Ask an admin.`);
  }
}

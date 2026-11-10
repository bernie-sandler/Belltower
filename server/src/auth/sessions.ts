import type { UserRole } from '@tt/shared';
import { createHash, randomBytes } from 'node:crypto';
import { stmt } from '../db/connection';
import { nowIso, tx, type Ctx } from '../services/context';

export interface SessionRow {
  id: number;
  token_hash: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  remember: 0 | 1;
  user_agent: string | null;
  ip: string | null;
  /** Null only for leftovers from before 1.5, which startup deletes; lookups never return those. */
  user_id: number | null;
}

/** A live session and the (active) person it belongs to. */
export interface SessionWithUser extends SessionRow {
  user_id: number;
  user: SessionUser;
}

export interface SessionUser {
  id: number;
  username: string;
  role: UserRole;
  isOwner: boolean;
}

export interface SessionPolicy {
  /** Lifetime of a "remember this device" session, sliding on use. */
  rememberDays: number;
}

const IDLE_MS = 12 * 60 * 60 * 1000;
/** Avoid a DB write on every request: only slide the expiry this often. */
const TOUCH_INTERVAL_MS = 10 * 60 * 1000;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

function lifetimeMs(remember: boolean, policy: SessionPolicy): number {
  return remember ? policy.rememberDays * 24 * 60 * 60 * 1000 : IDLE_MS;
}

export function createSession(
  ctx: Ctx,
  policy: SessionPolicy,
  info: { userId: number; remember: boolean; userAgent?: string; ip?: string },
): { token: string; expiresAt: Date; session: SessionRow } {
  const token = randomBytes(32).toString('base64url');
  const now = ctx.clock.now();
  const expiresAt = new Date(now.getTime() + lifetimeMs(info.remember, policy));
  const result = stmt(
    ctx.db,
    `INSERT INTO sessions (token_hash, created_at, last_seen_at, expires_at, remember, user_agent, ip, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    hashToken(token),
    now.toISOString(),
    now.toISOString(),
    expiresAt.toISOString(),
    info.remember ? 1 : 0,
    info.userAgent?.slice(0, 300) ?? null,
    info.ip ?? null,
    info.userId,
  );
  const session = stmt(ctx.db, 'SELECT * FROM sessions WHERE id = ?').get(Number(result.lastInsertRowid)) as SessionRow;
  return { token, expiresAt, session };
}

type LookupRow = SessionRow & { u_username: string | null; u_role: UserRole | null; u_is_owner: 0 | 1 | null; u_disabled_at: string | null };

/**
 * Returns the live session for a cookie token, sliding its expiry when it hasn't been touched for a
 * while. `refreshed` tells the caller to re-send a persistent cookie with the new expiry. A session
 * of a deactivated person counts as no session. `touch: false` (requests the app makes on its own,
 * like the bell's poll) checks the session without sliding it, so an idle tab still times out.
 */
export function lookupSession(
  ctx: Ctx,
  policy: SessionPolicy,
  token: string,
  opts: { touch?: boolean } = {},
): { session: SessionWithUser; refreshed: boolean; expiresAt: Date } | null {
  const row = stmt(
    ctx.db,
    `SELECT s.*, u.username AS u_username, u.role AS u_role, u.is_owner AS u_is_owner, u.disabled_at AS u_disabled_at
       FROM sessions s LEFT JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
  ).get(hashToken(token)) as LookupRow | undefined;
  if (!row) return null;
  const now = ctx.clock.now();
  if (new Date(row.expires_at).getTime() <= now.getTime() || row.user_id === null || row.u_username === null) {
    stmt(ctx.db, 'DELETE FROM sessions WHERE id = ?').run(row.id);
    return null;
  }
  if (row.u_disabled_at !== null) return null;
  const { u_username, u_role, u_is_owner, u_disabled_at: _disabled, ...plain } = row;
  const user: SessionUser = { id: row.user_id, username: u_username, role: u_role!, isOwner: u_is_owner === 1 };
  const session: SessionWithUser = { ...plain, user_id: row.user_id, user };
  if (opts.touch !== false && now.getTime() - new Date(row.last_seen_at).getTime() >= TOUCH_INTERVAL_MS) {
    const expiresAt = new Date(now.getTime() + lifetimeMs(row.remember === 1, policy));
    stmt(ctx.db, 'UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').run(
      now.toISOString(),
      expiresAt.toISOString(),
      row.id,
    );
    return {
      session: { ...session, last_seen_at: now.toISOString(), expires_at: expiresAt.toISOString() },
      refreshed: true,
      expiresAt,
    };
  }
  return { session, refreshed: false, expiresAt: new Date(row.expires_at) };
}

export function deleteSessionByToken(ctx: Ctx, token: string): void {
  stmt(ctx.db, 'DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

/** Signs one person out on every device (optionally keeping one session). */
export function deleteUserSessions(ctx: Ctx, userId: number, exceptSessionId?: number): number {
  return tx(ctx, () =>
    exceptSessionId === undefined
      ? stmt(ctx.db, 'DELETE FROM sessions WHERE user_id = ?').run(userId).changes
      : stmt(ctx.db, 'DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(userId, exceptSessionId).changes,
  );
}

export function purgeExpiredSessions(ctx: Ctx): number {
  return stmt(ctx.db, 'DELETE FROM sessions WHERE expires_at <= ?').run(nowIso(ctx)).changes;
}

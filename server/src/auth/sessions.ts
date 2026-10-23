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
  info: { remember: boolean; userAgent?: string; ip?: string },
): { token: string; expiresAt: Date; session: SessionRow } {
  const token = randomBytes(32).toString('base64url');
  const now = ctx.clock.now();
  const expiresAt = new Date(now.getTime() + lifetimeMs(info.remember, policy));
  const result = stmt(
    ctx.db,
    `INSERT INTO sessions (token_hash, created_at, last_seen_at, expires_at, remember, user_agent, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    hashToken(token),
    now.toISOString(),
    now.toISOString(),
    expiresAt.toISOString(),
    info.remember ? 1 : 0,
    info.userAgent?.slice(0, 300) ?? null,
    info.ip ?? null,
  );
  const session = stmt(ctx.db, 'SELECT * FROM sessions WHERE id = ?').get(Number(result.lastInsertRowid)) as SessionRow;
  return { token, expiresAt, session };
}

/**
 * Returns the live session for a cookie token, sliding its expiry when it hasn't been touched for a
 * while. `refreshed` tells the caller to re-send a persistent cookie with the new expiry.
 */
export function lookupSession(
  ctx: Ctx,
  policy: SessionPolicy,
  token: string,
): { session: SessionRow; refreshed: boolean; expiresAt: Date } | null {
  const row = stmt(ctx.db, 'SELECT * FROM sessions WHERE token_hash = ?').get(hashToken(token)) as
    | SessionRow
    | undefined;
  if (!row) return null;
  const now = ctx.clock.now();
  if (new Date(row.expires_at).getTime() <= now.getTime()) {
    stmt(ctx.db, 'DELETE FROM sessions WHERE id = ?').run(row.id);
    return null;
  }
  if (now.getTime() - new Date(row.last_seen_at).getTime() >= TOUCH_INTERVAL_MS) {
    const expiresAt = new Date(now.getTime() + lifetimeMs(row.remember === 1, policy));
    stmt(ctx.db, 'UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').run(
      now.toISOString(),
      expiresAt.toISOString(),
      row.id,
    );
    return {
      session: { ...row, last_seen_at: now.toISOString(), expires_at: expiresAt.toISOString() },
      refreshed: true,
      expiresAt,
    };
  }
  return { session: row, refreshed: false, expiresAt: new Date(row.expires_at) };
}

export function deleteSessionByToken(ctx: Ctx, token: string): void {
  stmt(ctx.db, 'DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

/** Signs out every device (optionally keeping one session). */
export function deleteAllSessions(ctx: Ctx, exceptSessionId?: number): number {
  return tx(ctx, () =>
    exceptSessionId === undefined
      ? stmt(ctx.db, 'DELETE FROM sessions').run().changes
      : stmt(ctx.db, 'DELETE FROM sessions WHERE id <> ?').run(exceptSessionId).changes,
  );
}

export function purgeExpiredSessions(ctx: Ctx): number {
  return stmt(ctx.db, 'DELETE FROM sessions WHERE expires_at <= ?').run(nowIso(ctx)).changes;
}

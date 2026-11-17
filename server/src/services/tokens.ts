// API tokens for automation (Uptime Kuma, scripts, Home Assistant…). A token is shown once when
// it's created; only its SHA-256 hash is stored, like session tokens. A token acts for the person
// who made it, and stops working (without being revoked) while that person is deactivated.

import { createHash, randomBytes } from 'node:crypto';
import type { ApiTokenBody, ApiTokenInfo, TokenScope, UserRole } from '@tt/shared';
import { stmt } from '../db/connection';
import { notFound } from '../errors';
import { actorUserId, nowIso, type Ctx } from './context';

interface Row {
  id: number;
  name: string;
  token_hash: string;
  prefix: string;
  can_complete: 0 | 1;
  scope: TokenScope;
  rings_bell: 0 | 1;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  user_id: number | null;
}

/** A token with its owner's directory fields (LEFT JOIN users). */
interface ListRow extends Row {
  u_username: string | null;
  u_display_name: string | null;
  u_role: UserRole | null;
  u_disabled_at: string | null;
  u_deleted_at: string | null;
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

const SELECT_WITH_OWNER = `SELECT t.*, u.username AS u_username, u.display_name AS u_display_name, u.role AS u_role,
         u.disabled_at AS u_disabled_at, u.deleted_at AS u_deleted_at
    FROM api_tokens t LEFT JOIN users u ON u.id = t.user_id`;

const toInfo = (r: ListRow): ApiTokenInfo => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  canComplete: r.can_complete === 1,
  scope: r.scope,
  ringsBell: r.rings_bell === 1,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  revokedAt: r.revoked_at,
  owner:
    r.user_id !== null && r.u_username !== null
      ? {
          id: r.user_id,
          username: r.u_username,
          displayName: r.u_display_name!,
          role: r.u_role!,
          disabled: r.u_disabled_at !== null,
          deleted: r.u_deleted_at !== null,
        }
      : null,
});

/** Every token (admins), or only one person's (`ownerId`). */
export function listTokens(ctx: Ctx, opts: { ownerId?: number } = {}): ApiTokenInfo[] {
  const order = 'ORDER BY t.revoked_at IS NOT NULL, t.id DESC';
  const rows =
    opts.ownerId === undefined
      ? (stmt(ctx.db, `${SELECT_WITH_OWNER} ${order}`).all() as ListRow[])
      : (stmt(ctx.db, `${SELECT_WITH_OWNER} WHERE t.user_id = ? ${order}`).all(opts.ownerId) as ListRow[]);
  return rows.map(toInfo);
}

/**
 * Creates a token for the acting person; the returned `token` is never retrievable again. A
 * read-only token can't complete tickets or ring the bell.
 */
export function createToken(ctx: Ctx, body: Omit<ApiTokenBody, 'scope' | 'ringsBell'> & { scope?: TokenScope; ringsBell?: boolean }): { token: string; info: ApiTokenInfo } {
  const scope = body.scope ?? 'full';
  const token = `tt_${randomBytes(24).toString('base64url')}`;
  const id = Number(
    stmt(ctx.db, 'INSERT INTO api_tokens (name, token_hash, prefix, can_complete, scope, rings_bell, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      body.name,
      hash(token),
      token.slice(0, 7),
      body.canComplete && scope === 'full' ? 1 : 0,
      scope,
      body.ringsBell && scope === 'full' ? 1 : 0,
      nowIso(ctx),
      actorUserId(ctx),
    ).lastInsertRowid,
  );
  return { token, info: toInfo(stmt(ctx.db, `${SELECT_WITH_OWNER} WHERE t.id = ?`).get(id) as ListRow) };
}

/**
 * Whether any working token rings the bell (unrevoked, owner active): with Teams off, the bell then
 * shows for admins.
 */
export function anyBellTokens(ctx: Ctx): boolean {
  return (
    stmt(
      ctx.db,
      `SELECT EXISTS (SELECT 1 FROM api_tokens t LEFT JOIN users u ON u.id = t.user_id
        WHERE t.rings_bell = 1 AND t.revoked_at IS NULL AND u.disabled_at IS NULL)`,
    )
      .pluck()
      .get() === 1
  );
}

/** Revokes a token: any token (admins), or only one person's own (`ownerId`); anything else is a 404. */
export function revokeToken(ctx: Ctx, id: number, opts: { ownerId?: number } = {}): void {
  const info =
    opts.ownerId === undefined
      ? stmt(ctx.db, 'UPDATE api_tokens SET revoked_at = coalesce(revoked_at, ?) WHERE id = ?').run(nowIso(ctx), id)
      : stmt(ctx.db, 'UPDATE api_tokens SET revoked_at = coalesce(revoked_at, ?) WHERE id = ? AND user_id = ?').run(nowIso(ctx), id, opts.ownerId);
  if (!info.changes) throw notFound('Token not found');
}

export interface TokenIdentity {
  id: number;
  name: string;
  canComplete: boolean;
  scope: TokenScope;
  /** Its new tickets ring admins' bell like submit-page tickets. */
  ringsBell: boolean;
  /** Who the token acts for (null: made before 1.5 and not adopted yet). */
  userId: number | null;
}

/**
 * The token's identity, or null for unknown or revoked tokens and tokens whose owner is
 * deactivated. Notes when it was last used.
 */
export function authenticateToken(ctx: Ctx, token: string): TokenIdentity | null {
  if (!/^tt_[\w-]{20,}$/.test(token)) return null;
  const row = stmt(
    ctx.db,
    `${SELECT_WITH_OWNER} WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
  ).get(hash(token)) as ListRow | undefined;
  if (!row || row.u_disabled_at !== null) return null;
  // At most once a minute, so a chatty monitor doesn't write on every call.
  const now = ctx.clock.now().getTime();
  if (!row.last_used_at || now - Date.parse(row.last_used_at) > 60_000) {
    stmt(ctx.db, 'UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(nowIso(ctx), row.id);
  }
  return { id: row.id, name: row.name, canComplete: row.can_complete === 1, scope: row.scope, ringsBell: row.rings_bell === 1, userId: row.user_id };
}

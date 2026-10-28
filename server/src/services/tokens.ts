// API tokens for automation (Uptime Kuma, scripts, Home Assistant…). A token is shown once when
// it's created; only its SHA-256 hash is stored, like session tokens.

import { createHash, randomBytes } from 'node:crypto';
import type { ApiTokenBody, ApiTokenInfo } from '@tt/shared';
import { stmt } from '../db/connection';
import { notFound } from '../errors';
import { nowIso, type Ctx } from './context';

interface Row {
  id: number;
  name: string;
  token_hash: string;
  prefix: string;
  can_complete: 0 | 1;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

const toInfo = (r: Row): ApiTokenInfo => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  canComplete: r.can_complete === 1,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  revokedAt: r.revoked_at,
});

export function listTokens(ctx: Ctx): ApiTokenInfo[] {
  return (stmt(ctx.db, 'SELECT * FROM api_tokens ORDER BY revoked_at IS NOT NULL, id DESC').all() as Row[]).map(toInfo);
}

/** Creates a token; the returned `token` is never retrievable again. */
export function createToken(ctx: Ctx, body: ApiTokenBody): { token: string; info: ApiTokenInfo } {
  const token = `tt_${randomBytes(24).toString('base64url')}`;
  const id = Number(
    stmt(ctx.db, 'INSERT INTO api_tokens (name, token_hash, prefix, can_complete, created_at) VALUES (?, ?, ?, ?, ?)').run(
      body.name,
      hash(token),
      token.slice(0, 7),
      body.canComplete ? 1 : 0,
      nowIso(ctx),
    ).lastInsertRowid,
  );
  return { token, info: toInfo(stmt(ctx.db, 'SELECT * FROM api_tokens WHERE id = ?').get(id) as Row) };
}

export function revokeToken(ctx: Ctx, id: number): void {
  const info = stmt(ctx.db, 'UPDATE api_tokens SET revoked_at = coalesce(revoked_at, ?) WHERE id = ?').run(nowIso(ctx), id);
  if (!info.changes) throw notFound('Token not found');
}

export interface TokenIdentity {
  id: number;
  name: string;
  canComplete: boolean;
}

/** The token's identity, or null for unknown or revoked tokens. Notes when it was last used. */
export function authenticateToken(ctx: Ctx, token: string): TokenIdentity | null {
  if (!/^tt_[\w-]{20,}$/.test(token)) return null;
  const row = stmt(ctx.db, 'SELECT * FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL').get(hash(token)) as Row | undefined;
  if (!row) return null;
  // At most once a minute, so a chatty monitor doesn't write on every call.
  const now = ctx.clock.now().getTime();
  if (!row.last_used_at || now - Date.parse(row.last_used_at) > 60_000) {
    stmt(ctx.db, 'UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(nowIso(ctx), row.id);
  }
  return { id: row.id, name: row.name, canComplete: row.can_complete === 1 };
}

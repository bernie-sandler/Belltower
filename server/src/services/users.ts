// People: admins and members. Accounts are deactivated, never deleted, so history keeps its names.
// The owner is the account the install was set up with (or the one 1.4's password became): its
// password can come from APP_PASSWORD, and it can't be demoted or deactivated, so there is always
// a way back in. Passwords are hashed by the caller (hashing is async; services are synchronous).

import { OWNER_ALIAS, type MeResponse, type UpdateMeBody, type UpdateUserBody, type UserInfo, type UserRef, type UserRole } from '@tt/shared';
import { stmt } from '../db/connection';
import { AppError, conflict, notFound } from '../errors';
import { deleteUserSessions } from '../auth/sessions';
import { actorUserId, nowIso, tx, type Ctx } from './context';

export interface UserRow {
  id: number;
  username: string;
  display_name: string;
  email: string | null;
  role: UserRole;
  is_owner: 0 | 1;
  password_hash: string | null;
  oidc_issuer: string | null;
  oidc_subject: string | null;
  discord_user_id: string | null;
  ntfy_topic: string | null;
  notify_prefs: string;
  created_at: string;
  disabled_at: string | null;
}

export function toUserRef(r: UserRow): UserRef {
  return { id: r.id, username: r.username, displayName: r.display_name, role: r.role, disabled: r.disabled_at !== null };
}

function toUserInfo(r: UserRow, showEmail: boolean): UserInfo {
  return {
    ...toUserRef(r),
    isOwner: r.is_owner === 1,
    email: showEmail ? r.email : null,
    hasPassword: r.password_hash !== null,
    createdAt: r.created_at,
    disabledAt: r.disabled_at,
  };
}

export function hasUsers(ctx: Ctx): boolean {
  return stmt(ctx.db, 'SELECT EXISTS (SELECT 1 FROM users)').pluck().get() === 1;
}

export function findUser(ctx: Ctx, id: number): UserRow | undefined {
  return stmt(ctx.db, 'SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function getUser(ctx: Ctx, id: number): UserRow {
  const row = findUser(ctx, id);
  if (!row) throw notFound('Person not found');
  return row;
}

/** Usernames compare without case (the column is NOCASE). */
export function findUserByUsername(ctx: Ctx, username: string): UserRow | undefined {
  return stmt(ctx.db, 'SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
}

export function getOwner(ctx: Ctx): UserRow | undefined {
  return stmt(ctx.db, 'SELECT * FROM users WHERE is_owner = 1').get() as UserRow | undefined;
}

/** Who a login is for: no name (how 1.4 signed in) and the old saved name `tower-tracker` mean the owner. */
export function loginCandidate(ctx: Ctx, username: string | undefined): UserRow | undefined {
  const name = username?.trim() ?? '';
  if (name === '' || name.toLowerCase() === OWNER_ALIAS) return getOwner(ctx);
  return findUserByUsername(ctx, name);
}

/** Whether the acting person is an active admin. */
export function actorIsAdmin(ctx: Ctx): boolean {
  const id = actorUserId(ctx);
  if (id === null) return false;
  const u = findUser(ctx, id);
  return !!u && u.role === 'admin' && u.disabled_at === null;
}

function activeAdminCount(ctx: Ctx): number {
  return stmt(ctx.db, `SELECT count(*) FROM users WHERE role = 'admin' AND disabled_at IS NULL`).pluck().get() as number;
}

/** The directory: active people first, then by name. Email only for admins and for your own entry. */
export function listUsers(ctx: Ctx): UserInfo[] {
  const admin = actorIsAdmin(ctx);
  const me = actorUserId(ctx);
  const rows = stmt(ctx.db, 'SELECT * FROM users ORDER BY disabled_at IS NOT NULL, display_name COLLATE NOCASE, id').all() as UserRow[];
  return rows.map((r) => toUserInfo(r, admin || r.id === me));
}

/** One person, as an admin sees them. */
export function userInfo(ctx: Ctx, id: number): UserInfo {
  return toUserInfo(getUser(ctx, id), true);
}

export function meResponse(ctx: Ctx, id: number, passwordSourceEnv: boolean): MeResponse {
  const row = getUser(ctx, id);
  return { ...toUserInfo(row, true), passwordManagedByEnv: passwordSourceEnv && row.is_owner === 1 };
}

function assertUsernameFree(ctx: Ctx, username: string): void {
  if (findUserByUsername(ctx, username)) throw conflict('username_taken', `The username “${username}” is already taken`);
}

/** Creates the owner on a fresh install (first-run setup, or APP_PASSWORD). Null if someone already exists. */
export function createOwner(ctx: Ctx, input: { username: string; displayName: string; passwordHash: string }): number | null {
  const info = stmt(
    ctx.db,
    `INSERT INTO users (username, display_name, role, is_owner, password_hash, created_at)
     SELECT ?, ?, 'admin', 1, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
  ).run(input.username, input.displayName, input.passwordHash, nowIso(ctx));
  return info.changes ? Number(info.lastInsertRowid) : null;
}

export function createUser(
  ctx: Ctx,
  input: { username: string; displayName: string; role: UserRole; email?: string | null },
  passwordHash: string,
): UserInfo {
  return tx(ctx, () => {
    assertUsernameFree(ctx, input.username);
    const id = Number(
      stmt(
        ctx.db,
        'INSERT INTO users (username, display_name, email, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(input.username, input.displayName, input.email ?? null, input.role, passwordHash, nowIso(ctx)).lastInsertRowid,
    );
    return userInfo(ctx, id);
  });
}

/**
 * An admin's changes to a person. The owner keeps the admin role and stays active, nobody
 * deactivates themselves or resets their own password here (that needs the current one, under
 * Account), and at least one active admin always remains. Deactivating someone or resetting their
 * password signs them out everywhere. `expectedUsername` guards against the id meaning someone else
 * by now (a restore can renumber people while the caller was hashing a password).
 */
export function updateUser(
  ctx: Ctx,
  id: number,
  patch: Omit<UpdateUserBody, 'password'>,
  opts: { passwordHash?: string; ownerPasswordFromEnv: boolean; expectedUsername?: string },
): UserInfo {
  return tx(ctx, () => {
    const row = getUser(ctx, id);
    if (opts.expectedUsername !== undefined && row.username !== opts.expectedUsername) {
      throw conflict('user_changed', 'This person changed meanwhile (was a backup restored?); reload and try again');
    }
    const isOwner = row.is_owner === 1;
    const self = actorUserId(ctx) === id;
    const role = patch.role ?? row.role;
    const disabled = patch.disabled ?? row.disabled_at !== null;

    if (isOwner && role !== 'admin') throw conflict('owner_protected', 'The owner is always an admin');
    if (isOwner && disabled) throw conflict('owner_protected', 'The owner can’t be deactivated');
    if (self && disabled && row.disabled_at === null) throw conflict('cannot_disable_self', 'You can’t deactivate your own account');
    if (self && opts.passwordHash !== undefined) {
      throw conflict('use_account_password', 'Change your own password under Account → Password (it asks for the current one)');
    }
    if (opts.passwordHash !== undefined && isOwner) {
      if (opts.ownerPasswordFromEnv) {
        throw conflict('managed_by_env', 'The owner’s password is set by APP_PASSWORD; change it there and restart');
      }
      throw conflict('owner_protected', 'Only the owner can change the owner’s password (under Account)');
    }
    const wasActiveAdmin = row.role === 'admin' && row.disabled_at === null;
    if (wasActiveAdmin && (role !== 'admin' || disabled) && activeAdminCount(ctx) <= 1) {
      throw conflict('last_admin', 'At least one active admin has to remain');
    }

    const now = nowIso(ctx);
    stmt(ctx.db, 'UPDATE users SET display_name = ?, email = ?, role = ?, disabled_at = ? WHERE id = ?').run(
      patch.displayName ?? row.display_name,
      patch.email !== undefined ? patch.email : row.email,
      role,
      disabled ? (row.disabled_at ?? now) : null,
      id,
    );
    if (opts.passwordHash !== undefined) stmt(ctx.db, 'UPDATE users SET password_hash = ? WHERE id = ?').run(opts.passwordHash, id);
    if ((disabled && row.disabled_at === null) || opts.passwordHash !== undefined) deleteUserSessions(ctx, id);
    return userInfo(ctx, id);
  });
}

/** Your own profile. */
export function updateMe(ctx: Ctx, id: number, patch: UpdateMeBody): void {
  const row = getUser(ctx, id);
  stmt(ctx.db, 'UPDATE users SET display_name = ?, email = ? WHERE id = ?').run(
    patch.displayName ?? row.display_name,
    patch.email !== undefined ? patch.email : row.email,
    id,
  );
}

/** Compare-and-swap on a password hash, so concurrent changes can't silently undo each other. */
export function replacePasswordHash(ctx: Ctx, id: number, expected: string, next: string): boolean {
  return stmt(ctx.db, 'UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?').run(next, id, expected).changes === 1;
}

/** Startup with APP_PASSWORD: the owner is an active admin. True when something had to change. */
export function ensureOwnerActiveAdmin(ctx: Ctx, id: number): boolean {
  return stmt(ctx.db, `UPDATE users SET role = 'admin', disabled_at = NULL WHERE id = ? AND (role <> 'admin' OR disabled_at IS NOT NULL)`).run(id).changes === 1;
}

export function setPasswordHash(ctx: Ctx, id: number, hash: string): void {
  stmt(ctx.db, 'UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
}

/** For the guard: a user's 403 when a route is admin-only. */
export const adminOnly = () => new AppError(403, 'forbidden', 'Only an admin can do that');

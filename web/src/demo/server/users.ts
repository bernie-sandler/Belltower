// Mirrors server/src/services/users.ts: people can be deactivated (reversible) or deleted, which
// keeps their row with only the display name and username so history still names them; the owner stays an
// active admin; at least one active admin remains. The demo has no passwords: anyone signs in as
// the owner, and a password given for someone new is checked by the schema and then forgotten.

import type { CreateUserBody, MeResponse, UpdateMeBody, UpdateUserBody, UserInfo, UserRef } from '@tt/shared';
import { actorId, nextId, nowIso, type Ctx, type UserRow } from './db';
import { badRequest, conflict, notFound } from './errors';

export function toUserRef(r: UserRow): UserRef {
  return {
    id: r.id,
    username: r.username,
    displayName: r.displayName,
    role: r.role,
    disabled: r.disabledAt !== null,
    deleted: r.deletedAt !== null,
  };
}

function toUserInfo(ctx: Ctx, r: UserRow, showEmail: boolean): UserInfo {
  return {
    ...toUserRef(r),
    isOwner: r.isOwner,
    email: showEmail ? r.email : null,
    hasPassword: r.hasPassword,
    createdAt: r.createdAt,
    disabledAt: r.disabledAt,
    tagScope: showEmail ? tagScopeOf(ctx, r) : null,
  };
}

/**
 * A restricted member's tags in tag order, or null (admins and the owner never are). Deleted tags drop
 * out here, as user_labels rows do on the server (ON DELETE CASCADE).
 */
function tagScopeOf(ctx: Ctx, r: UserRow): number[] | null {
  if (r.tagScope === null || r.role === 'admin' || r.isOwner) return null;
  return [...ctx.s.labels].sort((a, b) => a.position - b.position || a.id - b.id).filter((l) => r.tagScope!.includes(l.id)).map((l) => l.id);
}

export function getUser(ctx: Ctx, id: number): UserRow {
  const row = ctx.s.users.find((u) => u.id === id);
  if (!row) throw notFound('Person not found');
  return row;
}

export const getOwner = (ctx: Ctx): UserRow | undefined => ctx.s.users.find((u) => u.isOwner);

const findByUsername = (ctx: Ctx, username: string) => ctx.s.users.find((u) => u.username.toLowerCase() === username.toLowerCase());

/** Whether the acting person is an active admin. */
export function actorIsAdmin(ctx: Ctx): boolean {
  const id = actorId(ctx);
  const u = id === null ? undefined : ctx.s.users.find((x) => x.id === id);
  return !!u && u.role === 'admin' && u.disabledAt === null;
}

const activeAdmins = (ctx: Ctx) => ctx.s.users.filter((u) => u.role === 'admin' && u.disabledAt === null).length;

/**
 * The directory: active people first, then deactivated, then deleted (kept so done cards and history
 * can still name them), each by name. Email only for admins and for your own entry.
 */
export function listUsers(ctx: Ctx): UserInfo[] {
  const admin = actorIsAdmin(ctx);
  const me = actorId(ctx);
  return [...ctx.s.users]
    .sort(
      (a, b) =>
        Number(a.deletedAt !== null) - Number(b.deletedAt !== null) ||
        Number(a.disabledAt !== null) - Number(b.disabledAt !== null) ||
        a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }) ||
        a.id - b.id,
    )
    .map((u) => toUserInfo(ctx, u, admin || u.id === me));
}

export const userInfo = (ctx: Ctx, id: number): UserInfo => toUserInfo(ctx, getUser(ctx, id), true);

export function meResponse(ctx: Ctx, id: number): MeResponse {
  return { ...toUserInfo(ctx, getUser(ctx, id), true), passwordManagedByEnv: false, ssoLinked: false };
}

/** Seeding: adds someone as is (the owner flag included). */
export function addUser(ctx: Ctx, input: Pick<UserRow, 'username' | 'displayName' | 'role'> & Partial<Pick<UserRow, 'email' | 'isOwner'>>): UserRow {
  const row: UserRow = {
    id: nextId(ctx, 'users'),
    username: input.username,
    displayName: input.displayName,
    email: input.email ?? null,
    role: input.role,
    isOwner: input.isOwner ?? false,
    hasPassword: true,
    discordUserId: null,
    ntfyTopic: null,
    notifyPrefs: {},
    createdAt: nowIso(ctx),
    disabledAt: null,
    tagScope: null,
    deletedAt: null,
  };
  ctx.s.users.push(row);
  return row;
}

export function createUser(ctx: Ctx, input: Omit<CreateUserBody, 'password'>): UserInfo {
  const holder = findByUsername(ctx, input.username);
  if (holder?.deletedAt) {
    throw conflict('username_taken', `The username “${input.username}” belonged to someone who was deleted; pick another`);
  }
  if (holder) throw conflict('username_taken', `The username “${input.username}” is already taken`);
  return userInfo(ctx, addUser(ctx, { username: input.username, displayName: input.displayName, role: input.role, email: input.email ?? null }).id);
}

export function updateUser(ctx: Ctx, id: number, patch: Omit<UpdateUserBody, 'password'>, resetPassword: boolean): UserInfo {
  const row = getLiveUser(ctx, id);
  const self = actorId(ctx) === id;
  const role = patch.role ?? row.role;
  const disabled = patch.disabled ?? row.disabledAt !== null;
  if (row.isOwner && role !== 'admin') throw conflict('owner_protected', 'The owner is always an admin');
  if (row.isOwner && disabled) throw conflict('owner_protected', 'The owner can’t be deactivated');
  if (self && disabled && row.disabledAt === null) throw conflict('cannot_disable_self', 'You can’t deactivate your own account');
  if (self && resetPassword) {
    throw conflict('use_account_password', 'Change your own password under Account → Password (it asks for the current one)');
  }
  if (resetPassword && row.isOwner) throw conflict('owner_protected', 'Only the owner can change the owner’s password (under Account)');
  const wasActiveAdmin = row.role === 'admin' && row.disabledAt === null;
  if (wasActiveAdmin && (role !== 'admin' || disabled) && activeAdmins(ctx) <= 1) {
    throw conflict('last_admin', 'At least one active admin has to remain');
  }
  row.displayName = patch.displayName ?? row.displayName;
  if (patch.email !== undefined) row.email = patch.email;
  // Tag restriction: members only. Making someone an admin lifts it.
  const restrictTo = patch.tagScope ?? null;
  if (restrictTo !== null && (role === 'admin' || row.isOwner)) {
    throw conflict('cannot_restrict_admin', 'Admins and the owner always see every ticket; make them a member first');
  }
  if (restrictTo?.some((labelId) => !ctx.s.labels.some((l) => l.id === labelId))) {
    throw badRequest('invalid_label', 'That tag no longer exists; reload and pick again');
  }
  row.role = role;
  row.disabledAt = disabled ? (row.disabledAt ?? nowIso(ctx)) : null;
  if (patch.tagScope !== undefined || role === 'admin') row.tagScope = restrictTo ? [...new Set(restrictTo)] : null;
  return userInfo(ctx, id);
}

/** A person who hasn't been deleted (404 otherwise: there's nothing left to change). */
function getLiveUser(ctx: Ctx, id: number): UserRow {
  const row = getUser(ctx, id);
  if (row.deletedAt !== null) throw notFound('Person not found');
  return row;
}

/**
 * Deletes a person for good, like the server: the row stays (history points at it) with only the
 * names; email, password, Discord and ntfy settings and tag restriction are wiped, the username
 * stays taken, and the row is marked deactivated as well as deleted. Their watches and notifications go (the demo has no sessions or tokens). Their open
 * cards are the caller's job (cards.ts unassignOpenCards, after this).
 */
export function deleteUser(ctx: Ctx, id: number): UserRow {
  const row = getLiveUser(ctx, id);
  if (row.isOwner) throw conflict('owner_protected', 'The owner can’t be deleted');
  if (actorId(ctx) === id) throw conflict('cannot_delete_self', 'You can’t delete your own account');
  if (row.role === 'admin' && row.disabledAt === null && activeAdmins(ctx) <= 1) {
    throw conflict('last_admin', 'At least one active admin has to remain');
  }
  const deleted = { ...row };
  const now = nowIso(ctx);
  row.email = null;
  row.role = 'member';
  row.hasPassword = false;
  row.discordUserId = null;
  row.ntfyTopic = null;
  row.notifyPrefs = {};
  row.tagScope = null;
  row.disabledAt = row.disabledAt ?? now;
  row.deletedAt = now;
  ctx.s.watchers = ctx.s.watchers.filter((w) => w.userId !== id);
  ctx.s.notifications = ctx.s.notifications.filter((n) => n.userId !== id);
  return deleted;
}

export function updateMe(ctx: Ctx, id: number, patch: UpdateMeBody): void {
  const row = getUser(ctx, id);
  row.displayName = patch.displayName ?? row.displayName;
  if (patch.email !== undefined) row.email = patch.email;
}

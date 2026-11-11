// Single sign-on (OIDC): its settings, and whose account a sign-in opens. Everything here only
// reads and writes the database; the network side (discovery, the code exchange) is in
// auth/oidc.ts. The settings live in the private `oidc_settings` key: never exported in a backup,
// and kept from the live install when one is restored.

import {
  OIDC_PRESET_DEFAULTS,
  OIDC_PRESETS,
  OWNER_ALIAS,
  type OidcPreset,
  type OidcSettingsBody,
  type OidcSettingsInfo,
  type SsoErrorCode,
} from '@tt/shared';
import { getSetting, setSetting, stmt } from '../db/connection';
import { badRequest, conflict } from '../errors';
import { nowIso, tx, type Ctx } from './context';
import { getGeneralSettings } from './settings';
import { findUser, getUser, type UserRow } from './users';

export const OIDC_SETTINGS_KEY = 'oidc_settings';

export interface OidcSettings {
  enabled: boolean;
  preset: OidcPreset;
  buttonLabel: string;
  issuer: string;
  clientId: string;
  clientSecret: string | null;
  scopes: string;
  usernameClaim: string;
  groupsClaim: string;
  requiredGroup: string;
  autoCreate: boolean;
  linkByEmail: boolean;
  allowHttpIssuer: boolean;
}

const DEFAULTS: OidcSettings = {
  enabled: false,
  preset: 'authentik',
  buttonLabel: '',
  issuer: '',
  clientId: '',
  clientSecret: null,
  scopes: '',
  usernameClaim: 'preferred_username',
  groupsClaim: 'groups',
  requiredGroup: '',
  autoCreate: false,
  linkByEmail: false,
  allowHttpIssuer: false,
};

/** The saved settings, each field checked (a hand-edited row can't break sign-in into a crash). */
export function getOidcSettings(ctx: Ctx): OidcSettings {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(getSetting(ctx.db, OIDC_SETTINGS_KEY) ?? '{}') as unknown;
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
  } catch {
    // Unreadable: the defaults (single sign-on off).
  }
  const str = (k: keyof OidcSettings, fallback: string) => (typeof raw[k] === 'string' ? (raw[k] as string) : fallback);
  const bool = (k: keyof OidcSettings) => raw[k] === true;
  const preset = OIDC_PRESETS.includes(raw.preset as OidcPreset) ? (raw.preset as OidcPreset) : DEFAULTS.preset;
  return {
    enabled: bool('enabled'),
    preset,
    buttonLabel: str('buttonLabel', ''),
    issuer: str('issuer', ''),
    clientId: str('clientId', ''),
    clientSecret: typeof raw.clientSecret === 'string' && raw.clientSecret ? raw.clientSecret : null,
    scopes: str('scopes', ''),
    usernameClaim: str('usernameClaim', '') || DEFAULTS.usernameClaim,
    groupsClaim: str('groupsClaim', '') || DEFAULTS.groupsClaim,
    requiredGroup: str('requiredGroup', ''),
    autoCreate: bool('autoCreate'),
    linkByEmail: bool('linkByEmail'),
    allowHttpIssuer: bool('allowHttpIssuer'),
  };
}

/**
 * The issuer as each preset publishes it, because discovery compares it exactly: Authentik's ends
 * in a slash (`…/application/o/<slug>/`), Authelia's doesn't. Custom is left as typed; discovery
 * still retries once with the slash flipped.
 */
export function normalizeIssuer(preset: OidcPreset, issuer: string): string {
  const s = issuer.trim();
  if (!s) return s;
  if (preset === 'authentik') return s.endsWith('/') ? s : `${s}/`;
  if (preset === 'authelia') return s.replace(/\/+$/, '');
  return s;
}

/** The scopes asked for: the saved ones (or the preset's), always with `openid`. */
export function effectiveScopes(s: Pick<OidcSettings, 'preset' | 'scopes'>): string {
  const words = (s.scopes.trim() || OIDC_PRESET_DEFAULTS[s.preset].scopes).split(/\s+/).filter(Boolean);
  return [...new Set(['openid', ...words])].join(' ');
}

export function buttonLabel(s: Pick<OidcSettings, 'preset' | 'buttonLabel'>): string {
  return s.buttonLabel.trim() || OIDC_PRESET_DEFAULTS[s.preset].label;
}

/** Where the provider sends people back to, or null without General → This app's address. */
export function redirectUriFor(appUrl: string): string | null {
  return appUrl ? `${appUrl.replace(/\/+$/, '')}/api/auth/oidc/callback` : null;
}

/** The client secret in use: the environment's wins over the saved one. */
export function clientSecretOf(s: OidcSettings, envSecret: string | null): string | null {
  return envSecret ?? s.clientSecret;
}

/** On and complete: a sign-in can actually start. */
export function oidcReady(ctx: Ctx, s: OidcSettings, envSecret: string | null): boolean {
  return s.enabled && !!s.issuer && !!s.clientId && clientSecretOf(s, envSecret) !== null && !!getGeneralSettings(ctx).appUrl;
}

/** For /api/auth/status: the login button, or null. */
export function ssoStatus(ctx: Ctx, envSecret: string | null): { label: string } | null {
  const s = getOidcSettings(ctx);
  return oidcReady(ctx, s, envSecret) ? { label: buttonLabel(s) } : null;
}

export function oidcInfo(ctx: Ctx, envSecret: string | null): OidcSettingsInfo {
  const { clientSecret, ...s } = getOidcSettings(ctx);
  return {
    ...s,
    secretSet: (envSecret ?? clientSecret) !== null,
    secretFromEnv: envSecret !== null,
    redirectUri: redirectUriFor(getGeneralSettings(ctx).appUrl),
    ready: oidcReady(ctx, { ...s, clientSecret }, envSecret),
  };
}

/** Parses an issuer and checks its scheme against the plain-HTTP switch. */
export function checkIssuer(issuer: string, allowHttp: boolean): URL {
  let u: URL;
  try {
    u = new URL(issuer);
  } catch {
    throw badRequest('validation', 'The issuer isn’t a valid address');
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.search || u.hash) {
    throw badRequest('validation', 'Enter the issuer’s http:// or https:// address (no user name, ? or #)');
  }
  if (u.protocol === 'http:' && !allowHttp) {
    throw badRequest('insecure_issuer', 'The issuer uses http://. Use https://, or turn on “Allow a plain-HTTP issuer” (LAN only).');
  }
  return u;
}

/**
 * Saves the settings. The issuer is normalized for its preset. Moving the issuer to another origin
 * forgets the saved secret unless a new one comes with it, so the secret can't be sent somewhere
 * else by changing only the address. Turning it on needs the issuer, client ID, a secret and the
 * app's address (the redirect URI is built from it).
 */
export function updateOidcSettings(ctx: Ctx, body: OidcSettingsBody, envSecret: string | null): void {
  const current = getOidcSettings(ctx);
  const issuer = normalizeIssuer(body.preset, body.issuer);
  if (issuer) checkIssuer(issuer, body.allowHttpIssuer);
  let clientSecret = body.clientSecret === null ? current.clientSecret : body.clientSecret || null;
  const originOf = (u: string) => {
    try {
      return u ? new URL(u).origin : null;
    } catch {
      return null;
    }
  };
  if (body.clientSecret === null && current.issuer && originOf(issuer) !== originOf(current.issuer)) clientSecret = null;

  if (body.enabled) {
    if (!issuer || !body.clientId || (envSecret ?? clientSecret) === null) {
      throw badRequest('sso_incomplete', 'To turn on single sign-on, fill in the issuer, the client ID and the client secret');
    }
    if (!getGeneralSettings(ctx).appUrl) {
      throw badRequest('app_url_required', 'Set “This app’s address” under General first: the provider sends people back to it');
    }
  }
  const next: OidcSettings = { ...body, issuer, clientSecret };
  setSetting(ctx.db, OIDC_SETTINGS_KEY, JSON.stringify(next));
}

// ---- whose account a sign-in opens ----

/** Who the provider says signed in: its issuer, their subject, and the merged ID token and userinfo claims. */
export interface OidcIdentity {
  issuer: string;
  subject: string;
  claims: Record<string, unknown>;
}

export type SignInOutcome =
  | { ok: true; user: UserRow; how: 'linked' | 'email' | 'created' }
  | { ok: false; code: SsoErrorCode };

/** The groups claim as a list (a single string counts as one group). */
function groupsOf(claims: Record<string, unknown>, claim: string): string[] {
  const v = claims[claim];
  if (Array.isArray(v)) return v.filter((g): g is string => typeof g === 'string');
  return typeof v === 'string' && v ? [v] : [];
}

/** Checked on every sign-in and link: someone removed from the group stops getting in. */
export function hasRequiredGroup(s: OidcSettings, claims: Record<string, unknown>): boolean {
  const required = s.requiredGroup.trim();
  return !required || groupsOf(claims, s.groupsClaim).includes(required);
}

/** Up to `max` items, each cut to `len` characters and JSON-quoted (escapes quotes and line breaks), then "and N more". */
function quotedList(items: string[], max: number, len: number): string {
  const shown = items.slice(0, max).map((i) => JSON.stringify(i.slice(0, len)));
  if (items.length > shown.length) shown.push(`and ${items.length - shown.length} more`);
  return shown.join(', ');
}

/**
 * For the log when the group check fails: whether the groups claim came at all (else the names of
 * the claims that did, never their values), or which groups it held. Everything from the provider
 * is quoted and capped, so it can't forge log lines.
 */
export function describeGroupMiss(s: OidcSettings, claims: Record<string, unknown>): string {
  const claim = JSON.stringify(s.groupsClaim);
  const needs = `it needs ${JSON.stringify(s.requiredGroup.trim())} (exact, case-sensitive)`;
  if (!Object.hasOwn(claims, s.groupsClaim)) {
    const names = quotedList(Object.keys(claims).sort(), 40, 64);
    return (
      `the provider sent no ${claim} claim (it sent: ${names}). Check that Scopes includes "groups" (Belltower adds it ` +
      'itself when the provider lists it); some providers also leave the claim out for someone in no groups.'
    );
  }
  const v = claims[s.groupsClaim];
  if (typeof v !== 'string' && !(Array.isArray(v) && v.every((g) => typeof g === 'string'))) {
    return `${claim} isn't a name or a list of names (it's ${Array.isArray(v) ? 'a list of other values' : v === null ? 'null' : `a ${typeof v}`}); ${needs}.`;
  }
  const groups = groupsOf(claims, s.groupsClaim);
  return `${claim} holds ${groups.length ? quotedList(groups, 20, 100) : 'no groups'}; ${needs}.`;
}

/** A plain address: something@something, without spaces or control characters. */
const EMAIL_SHAPE = /^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+$/u;

/**
 * The email, only when the provider marks it verified with a real boolean `true` (a string
 * "true" doesn't count). 3–254 characters, the users table's limit.
 */
export function verifiedEmail(claims: Record<string, unknown>): string | null {
  const email = typeof claims.email === 'string' ? claims.email.trim() : '';
  return claims.email_verified === true && email.length >= 3 && email.length <= 254 && EMAIL_SHAPE.test(email) ? email : null;
}

/** Username rules (shared/schemas Username): 2–32 of a-z 0-9 . _ - */
const USERNAME_MAX = 32;

/** "Zoë.Smith@example.com" → "zoe.smith"; '' when nothing usable is left. */
export function sanitizeUsername(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/@.*$/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+/, '')
    .slice(0, USERNAME_MAX)
    .replace(/[._-]+$/, '');
}

function usernameTaken(ctx: Ctx, name: string): boolean {
  return name === OWNER_ALIAS || stmt(ctx.db, 'SELECT 1 FROM users WHERE username = ?').get(name) !== undefined;
}

/** A free username from the claims: the username claim, else the email's name part, else "user"; "-2", "-3"… when taken. */
export function pickUsername(ctx: Ctx, s: OidcSettings, claims: Record<string, unknown>): string {
  const fromClaim = typeof claims[s.usernameClaim] === 'string' ? sanitizeUsername(claims[s.usernameClaim] as string) : '';
  const fromEmail = typeof claims.email === 'string' ? sanitizeUsername(claims.email) : '';
  const base = [fromClaim, fromEmail].find((n) => n.length >= 2) ?? 'user';
  if (!usernameTaken(ctx, base)) return base;
  for (let n = 2; n < 10_000; n++) {
    const suffix = `-${n}`;
    const name = `${base.slice(0, USERNAME_MAX - suffix.length).replace(/[._-]+$/, '')}${suffix}`;
    if (!usernameTaken(ctx, name)) return name;
  }
  throw conflict('username_taken', 'No free username is left for this person');
}

function displayNameOf(claims: Record<string, unknown>, fallback: string): string {
  const parts = [claims.name, [claims.given_name, claims.family_name].filter((p) => typeof p === 'string').join(' ')];
  const name = parts.find((p): p is string => typeof p === 'string' && p.trim() !== '');
  return (name ?? fallback).replace(/\u0000/g, '').trim().slice(0, 60) || fallback;
}

function findByIdentity(ctx: Ctx, id: OidcIdentity): UserRow | undefined {
  return stmt(ctx.db, 'SELECT * FROM users WHERE oidc_issuer = ? AND oidc_subject = ?').get(id.issuer, id.subject) as UserRow | undefined;
}

/**
 * Whose account this sign-in opens, in order: the account already linked to this identity; with
 * "link by email" on, the one active non-admin account whose email matches the verified email
 * (an admin, a tie, or an account linked elsewhere is never picked); with "create accounts" on, a
 * new member. Otherwise, or for a deactivated account, the sign-in is refused, as is a new identity
 * whose verified email belongs to a deactivated person (so they can't come back as "bob-2"). The
 * required group is checked first, every time.
 */
export function resolveSignIn(ctx: Ctx, s: OidcSettings, id: OidcIdentity): SignInOutcome {
  if (!hasRequiredGroup(s, id.claims)) return { ok: false, code: 'group' };
  return tx(ctx, () => {
    const linked = findByIdentity(ctx, id);
    if (linked) return linked.disabled_at === null ? { ok: true, user: linked, how: 'linked' } : { ok: false, code: 'disabled' };

    const verified = verifiedEmail(id.claims);
    const email = s.linkByEmail ? verified : null;
    if (email) {
      const matches = stmt(ctx.db, 'SELECT * FROM users WHERE email = ? COLLATE NOCASE AND disabled_at IS NULL').all(email) as UserRow[];
      if (matches.length === 1 && matches[0]!.role !== 'admin' && matches[0]!.oidc_subject === null) {
        const user = matches[0]!;
        stmt(ctx.db, 'UPDATE users SET oidc_issuer = ?, oidc_subject = ? WHERE id = ?').run(id.issuer, id.subject, user.id);
        return { ok: true, user: findUser(ctx, user.id)!, how: 'email' };
      }
      // Someone has this email but can't be linked automatically: they link from Account instead.
      if (matches.length > 0) return { ok: false, code: 'link_required' };
    }

    // Someone deactivated stays out, whatever new identity they come back with.
    if (verified && stmt(ctx.db, 'SELECT 1 FROM users WHERE email = ? COLLATE NOCASE AND disabled_at IS NOT NULL').get(verified)) {
      return { ok: false, code: 'disabled' };
    }
    if (!s.autoCreate) return { ok: false, code: 'no_account' };
    const username = pickUsername(ctx, s, id.claims);
    const created = stmt(
      ctx.db,
      `INSERT INTO users (username, display_name, email, role, password_hash, oidc_issuer, oidc_subject, created_at)
       VALUES (?, ?, ?, 'member', NULL, ?, ?, ?)`,
    ).run(username, displayNameOf(id.claims, username), verified, id.issuer, id.subject, nowIso(ctx));
    return { ok: true, user: getUser(ctx, Number(created.lastInsertRowid)), how: 'created' };
  });
}

/** Links an identity to someone signed in. 'taken' when another account already has it. */
export function linkIdentity(ctx: Ctx, userId: number, id: OidcIdentity): 'ok' | 'taken' {
  return tx(ctx, () => {
    const holder = findByIdentity(ctx, id);
    if (holder && holder.id !== userId) return 'taken';
    stmt(ctx.db, 'UPDATE users SET oidc_issuer = ?, oidc_subject = ? WHERE id = ?').run(id.issuer, id.subject, userId);
    return 'ok';
  });
}

/** Removes your link. Refused for an account without a password, which would then have no way in. */
export function unlinkIdentity(ctx: Ctx, userId: number): void {
  const user = getUser(ctx, userId);
  if (user.oidc_subject === null) return;
  if (user.password_hash === null) {
    throw conflict('needs_password', 'Your account has no password, so unlinking would lock you out. Ask an admin to set a temporary password first.');
  }
  stmt(ctx.db, 'UPDATE users SET oidc_issuer = NULL, oidc_subject = NULL WHERE id = ?').run(userId);
}

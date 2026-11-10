// 1.5 people: signing in by username (and the owner's old saved name), admins and members, who
// did what, tokens that belong to someone, and APP_PASSWORD as the way back in.

import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapAuth } from '../src/auth/bootstrap';
import { createLogger } from '../src/logger';
import { registeredRoutes } from '../src/http/guard';
import { withActor } from '../src/services/context';
import { listRequestTypes } from '../src/services/requestTypes';
import { getSubmitSettings, updateSubmitSettings } from '../src/services/settings';
import { updateUser } from '../src/services/users';
import { PASSWORD, addPerson, client, loginAs, makeApp, sessionCookie, setupAndLogin, type TestApp } from './helpers';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.shutdown();
  t = undefined;
});

const silent = createLogger({ level: 'silent' });

/** A login from its own address (so the failed-login limiter doesn't get in the way). */
let n = 0;
function login(app: TestApp['app'], body: Record<string, unknown>) {
  n++;
  return app.inject({
    method: 'POST',
    url: '/api/auth/login',
    remoteAddress: `10.20.${Math.floor(n / 250)}.${n % 250}`,
    headers: { 'x-requested-with': 'tower-tracker' },
    payload: body,
  });
}

const ownerId = (app: TestApp) => app.ctx.db.prepare('SELECT id FROM users WHERE is_owner = 1').pluck().get() as number;

describe('signing in', () => {
  it('takes a username, the owner by default, and the old name tower-tracker for the owner', async () => {
    t = await makeApp();
    const admin = await setupAndLogin(t);
    await addPerson(t, admin, 'sam');

    const me = async (cookie: string) => (await client(t!.app, cookie)('GET', '/api/me')).json();
    expect(await me(sessionCookie(await login(t.app, { username: 'admin', password: PASSWORD })))).toMatchObject({ username: 'admin', isOwner: true, role: 'admin' });
    expect(await me(sessionCookie(await login(t.app, { username: 'ADMIN', password: PASSWORD })))).toMatchObject({ username: 'admin' });
    expect(await me(sessionCookie(await login(t.app, { password: PASSWORD })))).toMatchObject({ username: 'admin' });
    expect(await me(sessionCookie(await login(t.app, { username: '', password: PASSWORD })))).toMatchObject({ username: 'admin' });
    expect(await me(sessionCookie(await login(t.app, { username: 'Tower-Tracker', password: PASSWORD })))).toMatchObject({ username: 'admin' });
    expect(await me(sessionCookie(await login(t.app, { username: 'sam', password: PASSWORD })))).toMatchObject({ username: 'sam', isOwner: false, role: 'member' });
  });

  it('answers every failure the same way: wrong password, unknown, deactivated or password-less accounts', async () => {
    t = await makeApp();
    const admin = await setupAndLogin(t);
    const sam = await addPerson(t, admin, 'sam');
    await addPerson(t, admin, 'kim');
    expect((await client(t.app, admin)('PATCH', `/api/users/${sam.id}`, { disabled: true })).statusCode).toBe(200);
    t.ctx.db.prepare(`UPDATE users SET password_hash = NULL WHERE username = 'kim'`).run(); // signs in with SSO only

    for (const body of [
      { username: 'admin', password: 'wrong' },
      { username: 'nobody', password: PASSWORD },
      { username: 'sam', password: PASSWORD },
      { username: 'kim', password: PASSWORD },
      { username: 'kim', password: '' },
    ]) {
      const res = await login(t.app, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(body.password ? 401 : 400);
      if (body.password) expect(res.json()).toEqual({ error: 'invalid_password', message: 'Incorrect username or password' });
    }
  });

  it('first-run setup creates the owner with the chosen username', async () => {
    t = await makeApp();
    const res = await client(t.app)('POST', '/api/auth/setup', { setupCode: t.auth.setupCode, username: 'Rawls', displayName: 'R', password: PASSWORD });
    expect(res.statusCode).toBe(204);
    expect((await client(t.app, sessionCookie(res))('GET', '/api/me')).json()).toMatchObject({ username: 'rawls', displayName: 'R', isOwner: true, role: 'admin' });
    expect((await login(t.app, { username: 'rawls', password: PASSWORD })).statusCode).toBe(204);
    expect((await login(t.app, { password: PASSWORD })).statusCode).toBe(204); // still the owner by default
  });

  it('rejects reserved and malformed usernames at setup', async () => {
    t = await makeApp();
    for (const username of ['tower-tracker', 'a', 'has space', 'x'.repeat(33)]) {
      const res = await client(t.app)('POST', '/api/auth/setup', { setupCode: t.auth.setupCode, username, password: PASSWORD });
      expect(res.statusCode, username).toBe(400);
    }
  });
});

describe('sign-outs only affect that person', () => {
  it('a password change signs out your other devices, nobody else', async () => {
    t = await makeApp();
    const admin = await setupAndLogin(t);
    const sam = await addPerson(t, admin, 'sam');
    const samPhone = await loginAs(t, 'sam');
    const adminPhone = await loginAs(t, 'admin');

    const res = await client(t.app, sam.cookie)('POST', '/api/auth/password', { currentPassword: PASSWORD, newPassword: 'sams new password' });
    expect(res.statusCode).toBe(204);
    const status = async (cookie: string) => (await client(t!.app, cookie)('GET', '/api/board')).statusCode;
    expect(await status(sam.cookie)).toBe(200);
    expect(await status(samPhone)).toBe(401);
    expect(await status(admin)).toBe(200);
    expect(await status(adminPhone)).toBe(200);
    expect((await login(t.app, { username: 'sam', password: 'sams new password' })).statusCode).toBe(204);
  });

  it('deactivating someone signs them out and stops their logins until re-enabled', async () => {
    t = await makeApp();
    const admin = await setupAndLogin(t);
    const sam = await addPerson(t, admin, 'sam');
    const api = client(t.app, admin);
    expect((await api('PATCH', `/api/users/${sam.id}`, { disabled: true })).json()).toMatchObject({ disabled: true, disabledAt: expect.any(String) });
    expect((await client(t.app, sam.cookie)('GET', '/api/board')).statusCode).toBe(401);
    expect((await login(t.app, { username: 'sam', password: PASSWORD })).statusCode).toBe(401);
    expect((await client(t.app, admin)('GET', '/api/board')).statusCode).toBe(200);

    expect((await api('PATCH', `/api/users/${sam.id}`, { disabled: false })).json()).toMatchObject({ disabled: false, disabledAt: null });
    expect((await login(t.app, { username: 'sam', password: PASSWORD })).statusCode).toBe(204);
  });

  it('APP_PASSWORD gets the owner back in: new password, re-enabled admin, only the owner signed out', async () => {
    t = await makeApp();
    const admin = await setupAndLogin(t);
    const sam = await addPerson(t, admin, 'sam', 'admin');
    // However the owner ended up locked out (a restored or hand-edited database)…
    t.ctx.db.prepare(`UPDATE users SET role = 'member', disabled_at = '2026-10-10T15:00:00.000Z' WHERE is_owner = 1`).run();

    expect(await bootstrapAuth(t.ctx, 'recovery passphrase', silent)).toEqual({ setupCode: null, passwordSource: 'env' });
    expect(t.ctx.db.prepare('SELECT role, disabled_at FROM users WHERE is_owner = 1').get()).toEqual({ role: 'admin', disabled_at: null });
    expect((await client(t.app, admin)('GET', '/api/board')).statusCode).toBe(401);
    expect((await client(t.app, sam.cookie)('GET', '/api/board')).statusCode).toBe(200);
    expect((await login(t.app, { password: 'recovery passphrase' })).statusCode).toBe(204);
    expect((await login(t.app, { username: 'sam', password: PASSWORD })).statusCode).toBe(204);

    // The same password again changes nothing and signs nobody out.
    const kept = sessionCookie(await login(t.app, { username: 'admin', password: 'recovery passphrase' }));
    await bootstrapAuth(t.ctx, 'recovery passphrase', silent);
    expect((await client(t.app, kept)('GET', '/api/board')).statusCode).toBe(200);
  });

  it('a fresh install with APP_PASSWORD gets the owner admin, and tokens nobody owns go to the owner', async () => {
    t = await makeApp({ env: { APP_PASSWORD: 'from the environment' } });
    expect(t.ctx.db.prepare('SELECT username, role, is_owner FROM users').all()).toEqual([{ username: 'admin', role: 'admin', is_owner: 1 }]);
    t.ctx.db.prepare(`INSERT INTO api_tokens (name, token_hash, prefix, created_at) VALUES ('Leftover', ?, 'tt_zzzz', '2026-10-10T15:00:00.000Z')`).run('e'.repeat(64));
    await bootstrapAuth(t.ctx, 'from the environment', silent);
    expect(t.ctx.db.prepare(`SELECT user_id FROM api_tokens WHERE name = 'Leftover'`).pluck().get()).toBe(ownerId(t));
  });

  it('APP_PASSWORD only manages the owner: members still change their own password', async () => {
    t = await makeApp({ env: { APP_PASSWORD: 'from the environment' } });
    const admin = sessionCookie(await login(t.app, { password: 'from the environment' }));
    const sam = await addPerson(t, admin, 'sam');
    expect((await client(t.app, admin)('GET', '/api/config')).json().passwordManagedByEnv).toBe(true);
    expect((await client(t.app, sam.cookie)('GET', '/api/config')).json().passwordManagedByEnv).toBe(false);
    expect((await client(t.app, sam.cookie)('GET', '/api/me')).json().passwordManagedByEnv).toBe(false);
    const own = await client(t.app, sam.cookie)('POST', '/api/auth/password', { currentPassword: PASSWORD, newPassword: 'another long password' });
    expect(own.statusCode).toBe(204);
    const alex = await addPerson(t, admin, 'alex', 'admin');
    const ownerReset = await client(t.app, alex.cookie)('PATCH', `/api/users/${ownerId(t)}`, { password: 'another long password' });
    expect(ownerReset.json().error).toBe('managed_by_env');
  });
});

describe('your own password only changes with the current one', () => {
  it('the people API refuses resetting your own password, for the owner and for any admin, and signs nobody out', async () => {
    t = await makeApp();
    const owner = await setupAndLogin(t);
    const alex = await addPerson(t, owner, 'alex', 'admin');
    for (const [cookie, id] of [
      [owner, ownerId(t)],
      [alex.cookie, alex.id],
    ] as const) {
      const res = await client(t.app, cookie)('PATCH', `/api/users/${id}`, { password: 'taken over by a stolen cookie' });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'use_account_password', message: expect.stringContaining('Account') });
      expect((await client(t.app, cookie)('GET', '/api/board')).statusCode).toBe(200);
    }
    expect((await login(t.app, { username: 'admin', password: 'taken over by a stolen cookie' })).statusCode).toBe(401);
    expect((await login(t.app, { username: 'alex', password: PASSWORD })).statusCode).toBe(204);
  });

  it('refuses a change when the id means someone else by now (a restore renumbered people)', async () => {
    t = await makeApp();
    const owner = await setupAndLogin(t);
    const sam = await addPerson(t, owner, 'sam');
    const asOwner = withActor(t.ctx, { kind: 'user', userId: ownerId(t) });
    expect(() => updateUser(asOwner, sam.id, { displayName: 'Not Sam' }, { ownerPasswordFromEnv: false, expectedUsername: 'kim' })).toThrow(
      expect.objectContaining({ code: 'user_changed' }),
    );
    expect(updateUser(asOwner, sam.id, { displayName: 'Sam R' }, { ownerPasswordFromEnv: false, expectedUsername: 'sam' }).displayName).toBe('Sam R');
  });
});

describe('people (admins manage, everyone reads the directory)', () => {
  it('adds people, keeps the owner an active admin, and always leaves one active admin', async () => {
    t = await makeApp();
    const admin = await setupAndLogin(t);
    const api = client(t.app, admin);
    const owner = ownerId(t);

    const created = await api('POST', '/api/users', { username: 'Alex', displayName: 'Alex Chen', role: 'admin', email: 'alex@example.com', password: PASSWORD });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ username: 'alex', displayName: 'Alex Chen', role: 'admin', email: 'alex@example.com', isOwner: false, hasPassword: true, disabled: false });
    const alex = created.json().id as number;
    expect((await api('POST', '/api/users', { username: 'ALEX', displayName: 'Again', password: PASSWORD })).json().error).toBe('username_taken');
    expect((await api('POST', '/api/users', { username: 'tower-tracker', displayName: 'Old', password: PASSWORD })).statusCode).toBe(400);
    expect((await api('POST', '/api/users', { username: 'short-pw', displayName: 'X', password: 'short' })).statusCode).toBe(400);

    expect((await api('PATCH', `/api/users/${owner}`, { role: 'member' })).json().error).toBe('owner_protected');
    expect((await api('PATCH', `/api/users/${owner}`, { disabled: true })).json().error).toBe('owner_protected');
    expect((await api('PATCH', `/api/users/${owner}`, { displayName: 'The Boss' })).json()).toMatchObject({ displayName: 'The Boss' });

    const alexApi = client(t.app, await loginAs(t, 'alex'));
    expect((await alexApi('PATCH', `/api/users/${alex}`, { disabled: true })).json().error).toBe('cannot_disable_self');
    expect((await alexApi('PATCH', `/api/users/${owner}`, { password: 'taking over the owner' })).json().error).toBe('owner_protected');
    // Alex may step down while the owner remains an admin…
    expect((await alexApi('PATCH', `/api/users/${alex}`, { role: 'member' })).json()).toMatchObject({ role: 'member' });
    // …and is a member from the next request on.
    expect((await alexApi('PATCH', `/api/users/${alex}`, { role: 'admin' })).statusCode).toBe(403);

    // The last active admin can't go (here the owner is the only one; a non-owner admin alone is the same).
    t.ctx.db.prepare('UPDATE users SET is_owner = 0').run();
    expect((await api('PATCH', `/api/users/${owner}`, { role: 'member' })).json().error).toBe('last_admin');
    t.ctx.db.prepare('UPDATE users SET is_owner = 1 WHERE id = ?').run(owner);

    expect((await api('PATCH', '/api/users/9999', { displayName: 'x' })).statusCode).toBe(404);
  });

  it('resetting someone’s password signs them out; the new one works', async () => {
    t = await makeApp();
    const admin = await setupAndLogin(t);
    const sam = await addPerson(t, admin, 'sam');
    expect((await client(t.app, admin)('PATCH', `/api/users/${sam.id}`, { password: 'temporary password 2' })).statusCode).toBe(200);
    expect((await client(t.app, sam.cookie)('GET', '/api/board')).statusCode).toBe(401);
    expect((await login(t.app, { username: 'sam', password: PASSWORD })).statusCode).toBe(401);
    expect((await login(t.app, { username: 'sam', password: 'temporary password 2' })).statusCode).toBe(204);
  });

  it('members read the directory (no one else’s email) and edit only their own profile', async () => {
    t = await makeApp();
    const admin = await setupAndLogin(t);
    await client(t.app, admin)('PATCH', '/api/me', { email: 'owner@example.com' });
    const sam = await addPerson(t, admin, 'sam');
    const api = client(t.app, sam.cookie);

    const dir = (await api('GET', '/api/users')).json();
    expect(dir.map((u: { username: string }) => u.username)).toEqual(['admin', 'sam']);
    expect(dir.find((u: { username: string }) => u.username === 'admin')).toMatchObject({ isOwner: true, email: null, role: 'admin' });
    expect((await client(t.app, admin)('GET', '/api/users')).json()[0]).toMatchObject({ email: 'owner@example.com' });

    const me = await api('PATCH', '/api/me', { displayName: 'Sam Rivera', email: 'sam@example.com' });
    expect(me.json()).toMatchObject({ username: 'sam', displayName: 'Sam Rivera', email: 'sam@example.com', isOwner: false, passwordManagedByEnv: false, hasPassword: true });
    expect((await api('PATCH', '/api/me', { email: 'not an email' })).statusCode).toBe(400);
    expect((await api('PATCH', '/api/me', { role: 'admin' })).json()).toMatchObject({ role: 'member' }); // ignored
    expect((await api('POST', '/api/users', { username: 'eve', displayName: 'Eve', password: PASSWORD })).statusCode).toBe(403);
    expect((await api('PATCH', `/api/users/${sam.id}`, { role: 'admin' })).json()).toMatchObject({ error: 'forbidden' });
  });
});

describe('roles', () => {
  /** Every admin-only /api route. A new route has to be added here or to MEMBER_ROUTES: decide who may call it. */
  const ADMIN_ROUTES = [
    'DELETE /api/backup/restore/:token',
    'DELETE /api/request-types/:id',
    'GET /api/backup/export.json',
    'GET /api/backup/export.zip',
    'GET /api/backup/snapshots',
    'GET /api/settings/oidc',
    'PATCH /api/users/:id',
    'POST /api/backup/restore',
    'POST /api/backup/restore/:token/confirm',
    'POST /api/request-types',
    'POST /api/settings/discord/digest-now',
    'POST /api/settings/discord/test',
    'POST /api/settings/notify/gotify/digest-now',
    'POST /api/settings/notify/gotify/test',
    'POST /api/settings/notify/ntfy/digest-now',
    'POST /api/settings/notify/ntfy/test',
    'POST /api/settings/notify/webhook/digest-now',
    'POST /api/settings/notify/webhook/test',
    'POST /api/settings/oidc/test',
    'POST /api/settings/submit/new-link',
    'POST /api/settings/submit/reset-status-links',
    'POST /api/users',
    'PUT /api/request-types/:id',
    'PUT /api/request-types/order',
    'PUT /api/settings/discord',
    'PUT /api/settings/general',
    'PUT /api/settings/notify',
    'PUT /api/settings/notify/gotify',
    'PUT /api/settings/notify/ntfy',
    'PUT /api/settings/notify/webhook',
    'PUT /api/settings/oidc',
    'PUT /api/settings/resolutions',
    'PUT /api/settings/submit',
  ];
  /** Everything else: board work, your own account and tokens, the public pages, the automation API. */
  const MEMBER_ROUTES = [
    'DELETE /api/attachments/:id',
    'DELETE /api/auth/oidc/link',
    'DELETE /api/cards/:id',
    'DELETE /api/cards/:id/links/:linkId',
    'DELETE /api/checklist-items/:id',
    'DELETE /api/checklists/:id',
    'DELETE /api/columns/:id',
    'DELETE /api/labels/:id',
    'DELETE /api/templates/:id',
    'DELETE /api/tokens/:id',
    'GET /api/activity/:id/revisions',
    'GET /api/ai/status',
    'GET /api/attachments/:id',
    'GET /api/attachments/:id/text',
    'GET /api/auth/oidc/callback',
    'GET /api/auth/oidc/start',
    'GET /api/auth/status',
    'GET /api/board',
    'GET /api/calendar',
    'GET /api/cards',
    'GET /api/cards/:id',
    'GET /api/cards/:id/activity',
    'GET /api/cards/:id/similar',
    'GET /api/cards/:id/status-link',
    'GET /api/config',
    'GET /api/me',
    'GET /api/public/status/:id/:sig',
    'GET /api/public/submit/:key',
    'GET /api/request-types',
    'GET /api/search',
    'GET /api/settings',
    'GET /api/similar',
    'GET /api/templates',
    'GET /api/templates/:id',
    'GET /api/tokens',
    'GET /api/users',
    'GET /api/v1/summary',
    'PATCH /api/activity/:id',
    'PATCH /api/cards/:id',
    'PATCH /api/checklist-items/:id',
    'PATCH /api/checklists/:id',
    'PATCH /api/columns/:id',
    'PATCH /api/labels/:id',
    'PATCH /api/me',
    'PATCH /api/templates/:id',
    'POST /api/ai/draft',
    'POST /api/ai/draft-many',
    'POST /api/auth/login',
    'POST /api/auth/logout',
    'POST /api/auth/oidc/link',
    'POST /api/auth/password',
    'POST /api/auth/setup',
    'POST /api/cards',
    'POST /api/cards/:id/archive',
    'POST /api/cards/:id/attachments',
    'POST /api/cards/:id/checklists',
    'POST /api/cards/:id/complete',
    'POST /api/cards/:id/links',
    'POST /api/cards/:id/move',
    'POST /api/cards/:id/restore',
    'POST /api/cards/:id/undelete',
    'POST /api/cards/:id/worklog',
    'POST /api/cards/archive-done',
    'POST /api/cards/move-many',
    'POST /api/checklists/:id/items',
    'POST /api/columns',
    'POST /api/columns/:id/sort-by-priority',
    'POST /api/import/cards',
    'POST /api/labels',
    'POST /api/public/submit/:key',
    'POST /api/templates',
    'POST /api/templates/:id/run',
    'POST /api/tickets',
    'POST /api/tokens',
    'POST /api/v1/cards',
    'POST /api/v1/hooks/uptime-kuma',
    'PUT /api/board/blocked-column',
    'PUT /api/cards/:id/checklists/order',
    'PUT /api/checklists/:id/items/order',
    'PUT /api/columns/order',
    'PUT /api/labels/order',
  ];

  it('every /api route has decided whether it is admin-only', async () => {
    t = await makeApp();
    const routes = registeredRoutes(t.app).filter((r) => r.url.startsWith('/api/') && r.method !== 'HEAD');
    const key = (r: { method: string; url: string }) => `${r.method} ${r.url}`;
    expect(routes.filter((r) => r.admin).map(key).sort()).toEqual(ADMIN_ROUTES);
    expect(routes.filter((r) => !r.admin).map(key).sort()).toEqual(MEMBER_ROUTES);
  });

  it('members get 403 on admin routes and do the board work', async () => {
    t = await makeApp();
    const admin = await setupAndLogin(t);
    const sam = await addPerson(t, admin, 'sam');
    const api = client(t.app, sam.cookie);
    const fill = (url: string) => url.replace(/:token/, 'abc').replace(/:id/, '1');
    for (const route of ADMIN_ROUTES) {
      const [method, url] = route.split(' ') as ['GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', string];
      const res = await api(method, fill(url), method === 'GET' || method === 'DELETE' ? undefined : {});
      expect(res.statusCode, route).toBe(403);
      expect(res.json().error, route).toBe('forbidden');
    }

    const card = await api('POST', '/api/cards', { title: 'Member card' });
    expect(card.statusCode).toBe(201);
    expect((await api('POST', `/api/cards/${card.json().id}/worklog`, { bodyMd: 'did a thing' })).statusCode).toBe(201);
    expect((await api('POST', '/api/columns', { name: 'Parts' })).statusCode).toBe(200);
    expect((await api('POST', '/api/labels', { name: 'Garage', color: '#4bce97' })).statusCode).toBe(200);
    expect((await api('GET', '/api/settings')).statusCode).toBe(200);
    expect((await api('POST', '/api/import/cards', { text: '{"title":"Imported"}', dryRun: true })).statusCode).toBe(200);
    // The admin still can.
    expect((await client(t.app, admin)('GET', '/api/backup/snapshots')).statusCode).toBe(200);
  });
});

describe('who did what', () => {
  it('history records the person, the token (with its owner), or nobody for the submit page and templates', async () => {
    t = await makeApp();
    const admin = await setupAndLogin(t);
    const sam = await addPerson(t, admin, 'sam');
    const card = (await client(t.app, sam.cookie)('POST', '/api/cards', { title: 'Fans loud' })).json();
    const note = (await client(t.app, sam.cookie)('POST', `/api/cards/${card.id}/worklog`, { bodyMd: 'Dusted' })).json();
    expect(note).toMatchObject({ userId: sam.id, tokenId: null });
    const edited = (await client(t.app, admin)('PATCH', `/api/activity/${note.id}`, { bodyMd: 'Dusted the fans' })).json();
    expect(edited.userId).toBe(sam.id); // the author stays the author
    const revisions = (await client(t.app, admin)('GET', `/api/activity/${note.id}/revisions`)).json();
    expect(revisions).toMatchObject([{ bodyMd: 'Dusted', userId: ownerId(t) }]);

    const { token, info } = (await client(t.app, admin)('POST', '/api/tokens', { name: 'Kuma' })).json();
    const v1 = await t.app.inject({ method: 'POST', url: '/api/v1/cards', headers: { authorization: `Bearer ${token}` }, payload: { title: 'NAS down' } });
    const history = (await client(t.app, admin)('GET', `/api/cards/${v1.json().card.id}/activity`)).json();
    expect(history[0]).toMatchObject({ type: 'created', userId: ownerId(t), tokenId: info.id });

    const created = (await client(t.app, admin)('GET', `/api/cards/${card.id}/activity`)).json().find((e: { type: string }) => e.type === 'created');
    expect(created).toMatchObject({ userId: sam.id, tokenId: null });

    const templates = (await client(t.app, admin)('GET', '/api/templates')).json();
    const made = (await client(t.app, sam.cookie)('POST', `/api/templates/${templates[0].id}/run`)).json();
    expect((await client(t.app, admin)('GET', `/api/cards/${made.id}/activity`)).json()[0]).toMatchObject({ userId: sam.id }); // "Create now" is a person's

    const createdBy = async (title: string) => {
      const id = t!.ctx.db.prepare('SELECT id FROM cards WHERE title = ? ORDER BY id DESC').pluck().get(title) as number;
      return (await client(t!.app, admin)('GET', `/api/cards/${id}/activity`)).json().find((e: { type: string }) => e.type === 'created');
    };

    // A template that comes due when someone saves it runs as the template, like the timer's runs.
    const today = t.clock.now().toISOString().slice(0, 10);
    expect((await client(t.app, sam.cookie)('PATCH', `/api/templates/${templates[1].id}`, { startDate: today, enabled: true })).statusCode).toBe(200);
    expect(await createdBy(templates[1].title)).toMatchObject({ userId: null, tokenId: null });

    // The submit page is nobody's.
    updateSubmitSettings(t.ctx, { enabled: true, columnId: null, pageTitle: 'Report a problem', intro: '' });
    const key = getSubmitSettings(t.ctx).key!;
    const plex = listRequestTypes(t.ctx).find((x) => x.name === 'Plex')!;
    const boundary = `----tt${Math.random().toString(16).slice(2)}`;
    const data = { typeId: plex.id, summary: 'stutters', description: 'Freezes', answers: { title: 'Interstellar', media: 'Movie', device: 'Roku' } };
    const submitted = await t.app.inject({
      method: 'POST',
      url: `/api/public/submit/${key}`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-requested-with': 'tower-tracker' },
      payload: `--${boundary}\r\nContent-Disposition: form-data; name="data"\r\n\r\n${JSON.stringify(data)}\r\n--${boundary}--\r\n`,
    });
    expect(submitted.statusCode).toBe(201);
    const ticket = t.ctx.db.prepare(`SELECT id FROM cards WHERE source_ref = 'submit' ORDER BY id DESC`).pluck().get() as number;
    const submittedHistory = (await client(t.app, admin)('GET', `/api/cards/${ticket}/activity`)).json() as { type: string; userId: number | null }[];
    expect(submittedHistory.find((e) => e.type === 'created')).toMatchObject({ userId: null, tokenId: null });
  });
});

describe('API tokens belong to someone', () => {
  it('members see and revoke only their own; admins see everyone’s with the owner', async () => {
    t = await makeApp();
    const admin = await setupAndLogin(t);
    const sam = await addPerson(t, admin, 'sam');
    const adminTok = (await client(t.app, admin)('POST', '/api/tokens', { name: 'Kuma' })).json();
    const samTok = (await client(t.app, sam.cookie)('POST', '/api/tokens', { name: 'Sam script', scope: 'read' })).json();
    expect(samTok.info.owner).toEqual({ id: sam.id, username: 'sam', displayName: 'sam', role: 'member', disabled: false });

    const names = async (cookie: string) => (await client(t!.app, cookie)('GET', '/api/tokens')).json().map((x: { name: string }) => x.name);
    expect(await names(sam.cookie)).toEqual(['Sam script']);
    expect(await names(admin)).toEqual(['Sam script', 'Kuma']);
    expect((await client(t.app, sam.cookie)('DELETE', `/api/tokens/${adminTok.info.id}`)).statusCode).toBe(404);
    expect((await client(t.app, admin)('DELETE', `/api/tokens/${samTok.info.id}`)).statusCode).toBe(204);
    expect((await client(t.app, sam.cookie)('GET', '/api/tokens')).json()[0].revokedAt).toEqual(expect.any(String));
  });

  it('stops working while its owner is deactivated, and works again when they are re-enabled', async () => {
    t = await makeApp();
    const admin = await setupAndLogin(t);
    const sam = await addPerson(t, admin, 'sam');
    const { token } = (await client(t.app, sam.cookie)('POST', '/api/tokens', { name: 'Homepage', scope: 'read' })).json();
    const summary = () => t!.app.inject({ method: 'GET', url: '/api/v1/summary', headers: { authorization: `Bearer ${token}` } });
    expect((await summary()).statusCode).toBe(200);

    await client(t.app, admin)('PATCH', `/api/users/${sam.id}`, { disabled: true });
    const blocked = await summary();
    expect(blocked.statusCode).toBe(401);
    expect(blocked.json().error).toBe('unauthenticated');
    expect((await client(t.app, admin)('GET', '/api/tokens')).json()[0]).toMatchObject({ revokedAt: null, owner: { disabled: true } });

    await client(t.app, admin)('PATCH', `/api/users/${sam.id}`, { disabled: false });
    expect((await summary()).statusCode).toBe(200);
  });
});

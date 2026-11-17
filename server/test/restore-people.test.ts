// Restoring with people (1.5): the live install decides who can sign in. The backup brings
// profiles, history and data; everyone's password, role, deactivation and signed-in devices come
// from the install being restored into, matched by username.

import { afterEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password';
import { PASSWORD, addPerson, client, loginAs, makeApp, setupAndLogin, type TestApp } from './helpers';

function multipart(filename: string, content: Buffer) {
  const boundary = '----ttpeople' + Math.random().toString(16).slice(2);
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/json\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

/** Uploads a JSON export and confirms it; returns the confirm response's status. */
async function restore(t: TestApp, cookie: string, data: unknown): Promise<number> {
  const m = multipart('backup.json', Buffer.from(JSON.stringify(data)));
  const preview = await t.app.inject({
    method: 'POST',
    url: '/api/backup/restore',
    headers: { ...m.headers, cookie, 'x-requested-with': 'tower-tracker' },
    payload: m.payload,
  });
  if (preview.statusCode !== 200) throw new Error(`preview failed: ${preview.statusCode} ${preview.body}`);
  const res = await client(t.app, cookie)('POST', `/api/backup/restore/${preview.json().token}/confirm`, { confirm: 'RESTORE' });
  return res.statusCode;
}

let apps: TestApp[] = [];
afterEach(async () => {
  for (const a of apps) await a.shutdown();
  apps = [];
});

async function app(): Promise<TestApp> {
  const a = await makeApp();
  apps.push(a);
  return a;
}

/** A source install: the owner, a member and an admin, a card by the member that both watch, and the owner's token. */
async function source() {
  const src = await app();
  const admin = await setupAndLogin(src);
  const sam = await addPerson(src, admin, 'sam');
  const alex = await addPerson(src, admin, 'alex', 'admin');
  await client(src.app, sam.cookie)('PATCH', '/api/me', { displayName: 'Sam Rivera', email: 'sam@example.com' });
  const card = (await client(src.app, sam.cookie)('POST', '/api/cards', { title: 'Garage door sensor' })).json();
  // Sam already watches it (made it in the app); OR IGNORE keeps that row.
  src.ctx.db.prepare(`INSERT OR IGNORE INTO card_watchers (card_id, user_id, created_at) VALUES (?, ?, ?), (?, ?, ?)`).run(card.id, sam.id, '2026-10-10T15:00:00.000Z', card.id, alex.id, '2026-10-10T15:00:00.000Z');
  await client(src.app, admin)('POST', '/api/tokens', { name: 'Kuma' });
  const data = (await client(src.app, admin)('GET', '/api/backup/export.json')).json();
  return { data, card, ids: { sam: sam.id, alex: alex.id } };
}

/** A destination install with its own passwords: the owner, `sam` (another password) and `casey` (not in the backup). */
async function destination() {
  const dst = await app();
  const admin = await setupAndLogin(dst);
  await client(dst.app, admin)('POST', '/api/users', { username: 'casey', displayName: 'Casey', role: 'member', password: 'casey password here' });
  await client(dst.app, admin)('POST', '/api/users', { username: 'sam', displayName: 'Sam (dst)', role: 'admin', password: 'sam on the destination' });
  const sam = await loginAs(dst, 'sam', 'sam on the destination');
  const casey = await loginAs(dst, 'casey', 'casey password here');
  return { dst, cookies: { admin, sam, casey } };
}

const loginStatus = async (t: TestApp, username: string, password: string) =>
  (await t.app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, headers: { 'x-requested-with': 'tower-tracker' }, payload: { username, password } })).statusCode;

describe('restore with people', () => {
  it('matched people keep their live sign-in, unmatched live people are added, everyone stays signed in', async () => {
    const { data, card, ids } = await source();
    const { dst, cookies } = await destination();
    expect(await restore(dst, cookies.admin, data)).toBe(200);
    const db = dst.ctx.db;

    // Everyone signed in stays signed in, as the same person.
    for (const [who, cookie] of Object.entries(cookies)) {
      const me = await client(dst.app, cookie)('GET', '/api/me');
      expect(me.statusCode, who).toBe(200);
      expect(me.json().username, who).toBe(who);
    }
    // Live passwords and roles; the backup's profile.
    expect(await loginStatus(dst, 'admin', PASSWORD)).toBe(204);
    expect(await loginStatus(dst, 'sam', 'sam on the destination')).toBe(204);
    expect(await loginStatus(dst, 'sam', PASSWORD)).toBe(401);
    expect(await loginStatus(dst, 'casey', 'casey password here')).toBe(204);
    expect(await loginStatus(dst, 'alex', PASSWORD)).toBe(401); // only in the backup: no password here
    const users = (await client(dst.app, cookies.admin)('GET', '/api/users')).json() as { username: string; role: string; displayName: string; isOwner: boolean; hasPassword: boolean; id: number }[];
    const by = Object.fromEntries(users.map((u) => [u.username, u]));
    expect(by.sam).toMatchObject({ id: ids.sam, role: 'admin', displayName: 'Sam Rivera', hasPassword: true });
    expect(by.alex).toMatchObject({ id: ids.alex, role: 'admin', hasPassword: false, isOwner: false });
    expect(by.casey).toMatchObject({ role: 'member', hasPassword: true });
    expect(users.filter((u) => u.isOwner).map((u) => u.username)).toEqual(['admin']);

    // History and watchers point at the backup's people; the token still has its owner.
    const created = (await client(dst.app, cookies.admin)('GET', `/api/cards/${card.id}/activity`)).json().find((e: { type: string }) => e.type === 'created');
    expect(created.userId).toBe(ids.sam);
    expect(db.prepare('SELECT user_id FROM card_watchers ORDER BY user_id').pluck().all()).toEqual([ids.sam, ids.alex]);
    expect((await client(dst.app, cookies.admin)('GET', '/api/tokens')).json()[0]).toMatchObject({ name: 'Kuma', owner: { username: 'admin' } });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.prepare('SELECT count(*) FROM sessions WHERE user_id IS NULL').pluck().get()).toBe(0);
  });

  it('a planted password, owner flag or single sign-on link in a hand-edited backup is ignored', async () => {
    const { data } = await source();
    const planted = await hashPassword('planted password!');
    for (const u of data.tables.users) {
      if (u.username === 'alex') Object.assign(u, { password_hash: planted, is_owner: 1, oidc_issuer: 'https://idp.example', oidc_subject: 'attacker' });
    }
    const { dst, cookies } = await destination();
    expect(await restore(dst, cookies.admin, data)).toBe(200);
    expect(await loginStatus(dst, 'alex', 'planted password!')).toBe(401);
    expect(dst.ctx.db.prepare('SELECT username FROM users WHERE is_owner = 1').pluck().all()).toEqual(['admin']);
    expect(dst.ctx.db.prepare(`SELECT oidc_issuer, oidc_subject FROM users WHERE username = 'alex'`).get()).toEqual({ oidc_issuer: null, oidc_subject: null });
  });

  it('a backup from before 1.5: the live people are added, tokens go to the owner, nobody is signed out', async () => {
    const { data } = await source();
    // As 1.4 exported it: no people, nothing attributed.
    data.schemaVersion = 8;
    delete data.tables.users;
    delete data.tables.card_watchers;
    for (const c of data.tables.cards) delete c.assignee_id;
    for (const a of data.tables.activity) {
      delete a.user_id;
      delete a.token_id;
    }
    for (const r of data.tables.activity_revisions) delete r.user_id;
    for (const tk of data.tables.api_tokens) {
      delete tk.user_id;
      delete tk.rings_bell; // 1.6
    }

    const { dst, cookies } = await destination();
    expect(await restore(dst, cookies.admin, data)).toBe(200);
    for (const [who, cookie] of Object.entries(cookies)) expect((await client(dst.app, cookie)('GET', '/api/me')).json().username, who).toBe(who);
    expect(await loginStatus(dst, 'sam', 'sam on the destination')).toBe(204);
    const users = (await client(dst.app, cookies.admin)('GET', '/api/users')).json() as { username: string; isOwner: boolean; role: string }[];
    expect(users.map((u) => u.username).sort()).toEqual(['admin', 'casey', 'sam']);
    expect((await client(dst.app, cookies.admin)('GET', '/api/tokens')).json()[0]).toMatchObject({ name: 'Kuma', owner: { username: 'admin' } });
    expect(dst.ctx.db.pragma('foreign_key_check')).toEqual([]);
  });

  it('the live single sign-on link wins over a restored person holding the same one', async () => {
    const { data } = await source();
    for (const u of data.tables.users) if (u.username === 'alex') Object.assign(u, { oidc_issuer: 'https://idp.example', oidc_subject: 'abc' });
    const { dst, cookies } = await destination();
    dst.ctx.db.prepare(`UPDATE users SET oidc_issuer = 'https://idp.example', oidc_subject = 'abc' WHERE username = 'casey'`).run();
    expect(await restore(dst, cookies.admin, data)).toBe(200);
    expect(dst.ctx.db.prepare('SELECT username FROM users WHERE oidc_subject IS NOT NULL').pluck().all()).toEqual(['casey']);
  });

  it('tag restrictions come from the live install, matched by tag name; a restricted person never ends up seeing more', async () => {
    const { data } = await source();
    // In the backup, sam is restricted (the destination's sam is an admin, who never is).
    const backupLabel = data.tables.labels[0];
    for (const u of data.tables.users) if (u.username === 'sam') u.tag_scoped = 1;
    data.tables.user_labels = [{ user_id: data.tables.users.find((u: { username: string }) => u.username === 'sam').id, label_id: backupLabel.id }];
    const { dst, cookies } = await destination();
    const api = client(dst.app, cookies.admin);
    // Both installs have the backup's first tag (the same seed); the destination also has its own.
    const live = (name: string) => dst.ctx.db.prepare('SELECT id FROM labels WHERE name = ? COLLATE NOCASE').pluck().get(name) as number;
    const gone = (await api('POST', '/api/labels', { name: 'Only on the destination', color: '#445566' })).json().id as number;
    const users = (await api('GET', '/api/users')).json() as { id: number; username: string }[];
    const casey = users.find((u) => u.username === 'casey')!.id;
    expect((await api('PATCH', `/api/users/${casey}`, { tagScope: [live(String(backupLabel.name)), gone] })).statusCode).toBe(200);

    expect(await restore(dst, cookies.admin, data)).toBe(200);
    const after = (await client(dst.app, cookies.admin)('GET', '/api/users')).json() as { username: string; tagScope: number[] | null }[];
    const restoredLabel = dst.ctx.db.prepare('SELECT id FROM labels WHERE name = ? COLLATE NOCASE').pluck().get(backupLabel.name) as number;
    // casey keeps the tag the backup has, loses the one it doesn't; sam is an admin live, so unrestricted.
    expect(after.find((u) => u.username === 'casey')!.tagScope).toEqual([restoredLabel]);
    expect(after.find((u) => u.username === 'sam')!.tagScope).toBeNull();
    expect(dst.ctx.db.pragma('foreign_key_check')).toEqual([]);
  });

  it('a live restricted person whose tags the backup lacks stays restricted and sees nothing', async () => {
    const { data } = await source();
    const { dst, cookies } = await destination();
    const api = client(dst.app, cookies.admin);
    const gone = (await api('POST', '/api/labels', { name: 'Only on the destination', color: '#445566' })).json().id as number;
    const users = (await api('GET', '/api/users')).json() as { id: number; username: string }[];
    const casey = users.find((u) => u.username === 'casey')!.id;
    expect((await api('PATCH', `/api/users/${casey}`, { tagScope: [gone] })).statusCode).toBe(200);
    expect(await restore(dst, cookies.admin, data)).toBe(200);
    const after = (await api('GET', '/api/users')).json() as { username: string; tagScope: number[] | null }[];
    expect(after.find((u) => u.username === 'casey')!.tagScope).toEqual([]);
    const board = (await client(dst.app, cookies.casey)('GET', '/api/board')).json();
    expect(board.cards).toEqual([]);
  });

  it('a deleted person stays deleted, whether the backup is from before or after the delete', async () => {
    const t = await app();
    const admin = await setupAndLogin(t);
    const sam = await addPerson(t, admin, 'sam');
    const card = (await client(t.app, sam.cookie)('POST', '/api/cards', { title: 'Garage door sensor' })).json();
    await client(t.app, sam.cookie)('PATCH', '/api/me', { email: 'sam@example.com' });
    const { token } = (await client(t.app, sam.cookie)('POST', '/api/tokens', { name: 'Homepage', scope: 'read' })).json();
    const summary = () => t.app.inject({ method: 'GET', url: '/api/v1/summary', headers: { authorization: `Bearer ${token}` } });
    expect((await summary()).statusCode).toBe(200);
    const before = (await client(t.app, admin)('GET', '/api/backup/export.json')).json();
    expect((await client(t.app, admin)('DELETE', `/api/users/${sam.id}`)).statusCode).toBe(200);
    const after = (await client(t.app, admin)('GET', '/api/backup/export.json')).json();

    // From after it: still deleted, and history still names them.
    expect(await restore(t, admin, after)).toBe(200);
    const kept = (await client(t.app, admin)('GET', '/api/users')).json() as { username: string; deleted: boolean }[];
    expect(kept.map((u) => [u.username, u.deleted])).toEqual([
      ['admin', false],
      ['sam', true],
    ]);
    const history = (await client(t.app, admin)('GET', `/api/cards/${card.id}/activity`)).json();
    expect(history.find((e: { type: string }) => e.type === 'created')).toMatchObject({ userName: 'sam', userDeleted: true });

    // From before the delete: the backup's sam is the same person (usernames of deleted people stay
    // taken), so the delete holds: no sign-in, no email, no watches, and their token stays revoked.
    expect(await restore(t, admin, before)).toBe(200);
    const people = (await client(t.app, admin)('GET', '/api/users')).json() as Record<string, unknown>[];
    expect(people.map((u) => u.username)).toEqual(['admin', 'sam']);
    expect(people.find((u) => u.username === 'sam')).toMatchObject({ deleted: true, disabled: true, hasPassword: false, email: null });
    expect((await client(t.app)('POST', '/api/auth/login', { username: 'sam', password: PASSWORD })).statusCode).toBe(401);
    expect((await summary()).statusCode).toBe(401);
    expect(t.ctx.db.prepare('SELECT count(*) FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL').pluck().get(sam.id)).toBe(0);
    expect(t.ctx.db.prepare('SELECT count(*) FROM card_watchers WHERE user_id = ?').pluck().get(sam.id)).toBe(0);
    const restoredHistory = (await client(t.app, admin)('GET', `/api/cards/${card.id}/activity`)).json();
    expect(restoredHistory.find((e: { type: string }) => e.type === 'created')).toMatchObject({ userName: 'sam', userDeleted: true });
  });

  it('a deleted person’s username stays taken through a restore that doesn’t have them, and the delete still holds after', async () => {
    const t = await app();
    const admin = await setupAndLogin(t);
    const empty = (await client(t.app, admin)('GET', '/api/backup/export.json')).json();
    const sam = await addPerson(t, admin, 'sam');
    const open = (await client(t.app, admin)('POST', '/api/cards', { title: 'Swap the UPS battery', assigneeId: sam.id })).json();
    const { token } = (await client(t.app, sam.cookie)('POST', '/api/tokens', { name: 'Homepage', scope: 'read' })).json();
    const summary = () => t.app.inject({ method: 'GET', url: '/api/v1/summary', headers: { authorization: `Bearer ${token}` } });
    const withSam = (await client(t.app, admin)('GET', '/api/backup/export.json')).json();
    expect((await client(t.app, admin)('DELETE', `/api/users/${sam.id}`)).statusCode).toBe(200);

    // A backup from before sam existed: their leftover row comes along, so the name stays taken.
    expect(await restore(t, admin, empty)).toBe(200);
    const after = (await client(t.app, admin)('GET', '/api/users')).json() as { username: string; deleted: boolean }[];
    expect(after.map((u) => [u.username, u.deleted])).toEqual([
      ['admin', false],
      ['sam', true],
    ]);
    expect((await client(t.app, admin)('POST', '/api/users', { username: 'sam', displayName: 'New Sam', password: PASSWORD })).statusCode).toBe(409);

    // Then one with sam active and assigned: still deleted, token dead, their open card back to nobody (logged).
    expect(await restore(t, admin, withSam)).toBe(200);
    const people = (await client(t.app, admin)('GET', '/api/users')).json() as Record<string, unknown>[];
    expect(people.find((u) => u.username === 'sam')).toMatchObject({ deleted: true, disabled: true });
    expect((await summary()).statusCode).toBe(401);
    const card = (await client(t.app, admin)('GET', `/api/cards/${open.id}`)).json();
    expect(card.assigneeId).toBeNull();
    const history = (await client(t.app, admin)('GET', `/api/cards/${open.id}/activity`)).json();
    expect(history.find((e: { type: string }) => e.type === 'assigned')).toMatchObject({ data: { to: null, fromName: 'sam' } });
  });

  it('a live active person matched to a row the backup has as deleted is active after the restore', async () => {
    const src = await app();
    const srcAdmin = await setupAndLogin(src);
    const gone = await addPerson(src, srcAdmin, 'casey');
    await client(src.app, srcAdmin)('DELETE', `/api/users/${gone.id}`);
    const data = (await client(src.app, srcAdmin)('GET', '/api/backup/export.json')).json();

    const { dst, cookies } = await destination(); // has an active casey
    expect(await restore(dst, cookies.admin, data)).toBe(200);
    const casey = ((await client(dst.app, cookies.admin)('GET', '/api/users')).json() as Record<string, unknown>[]).find((u) => u.username === 'casey');
    expect(casey).toMatchObject({ deleted: false, disabled: false });
    expect((await client(dst.app, cookies.casey)('GET', '/api/me')).statusCode).toBe(200);
    expect((await client(dst.app, cookies.admin)('PATCH', `/api/users/${casey!.id}`, { disabled: true })).statusCode).toBe(200);
  });
});

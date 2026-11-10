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
  src.ctx.db.prepare(`INSERT INTO card_watchers (card_id, user_id, created_at) VALUES (?, ?, ?), (?, ?, ?)`).run(card.id, sam.id, '2026-10-10T15:00:00.000Z', card.id, alex.id, '2026-10-10T15:00:00.000Z');
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

  it('a planted password or owner flag in a hand-edited backup is ignored', async () => {
    const { data } = await source();
    const planted = await hashPassword('planted password!');
    for (const u of data.tables.users) {
      if (u.username === 'alex') Object.assign(u, { password_hash: planted, is_owner: 1 });
    }
    const { dst, cookies } = await destination();
    expect(await restore(dst, cookies.admin, data)).toBe(200);
    expect(await loginStatus(dst, 'alex', 'planted password!')).toBe(401);
    expect(dst.ctx.db.prepare('SELECT username FROM users WHERE is_owner = 1').pluck().all()).toEqual(['admin']);
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
    for (const tk of data.tables.api_tokens) delete tk.user_id;

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
});

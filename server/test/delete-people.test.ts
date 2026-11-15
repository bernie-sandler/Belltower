// 1.5.0-rc.5: deleting people. History points at user rows, so a deleted person keeps their row
// with their name and username: everything else is wiped, the username stays taken, sessions go, tokens
// are revoked for good, open cards go back to nobody and done cards keep the name.

import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapAuth } from '../src/auth/bootstrap';
import { createLogger } from '../src/logger';
import { PASSWORD, addPerson, client, labelId, loginAs, makeApp, setupAndLogin, type TestApp } from './helpers';

let apps: TestApp[] = [];
afterEach(async () => {
  for (const a of apps) await a.shutdown();
  apps = [];
});

async function app(): Promise<{ t: TestApp; admin: string }> {
  const t = await makeApp();
  apps.push(t);
  return { t, admin: await setupAndLogin(t) };
}

const userRow = (t: TestApp, id: number) => t.ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, unknown>;
const ownerId = (t: TestApp) => t.ctx.db.prepare('SELECT id FROM users WHERE is_owner = 1').pluck().get() as number;

describe('who can delete whom', () => {
  it('admins only; never the owner or yourself; nobody twice', async () => {
    const { t, admin } = await app();
    const sam = await addPerson(t, admin, 'sam');
    const alex = await addPerson(t, admin, 'alex', 'admin');
    const kim = await addPerson(t, admin, 'kim');

    const asSam = await client(t.app, sam.cookie)('DELETE', `/api/users/${kim.id}`);
    expect(asSam.statusCode).toBe(403);
    expect(asSam.json().error).toBe('forbidden');
    expect((await client(t.app, alex.cookie)('DELETE', `/api/users/${ownerId(t)}`)).json()).toMatchObject({ error: 'owner_protected' });
    expect((await client(t.app, admin)('DELETE', `/api/users/${ownerId(t)}`)).json()).toMatchObject({ error: 'owner_protected' });
    expect((await client(t.app, alex.cookie)('DELETE', `/api/users/${alex.id}`)).json()).toMatchObject({ error: 'cannot_delete_self' });
    expect((await client(t.app, admin)('DELETE', '/api/users/9999')).statusCode).toBe(404);

    // Another admin can be deleted (the owner always remains an active admin).
    const deleted = await client(t.app, admin)('DELETE', `/api/users/${alex.id}`);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ unassigned: 0 });

    // Gone: no second delete, and nothing to change or re-enable.
    expect((await client(t.app, admin)('DELETE', `/api/users/${alex.id}`)).statusCode).toBe(404);
    expect((await client(t.app, admin)('PATCH', `/api/users/${alex.id}`, { disabled: false })).statusCode).toBe(404);
    expect((await client(t.app, admin)('PATCH', `/api/users/${alex.id}`, { displayName: 'Alex again' })).statusCode).toBe(404);
  });
});

describe('what deleting does', () => {
  it('wipes everything but the name, signs them out, and keeps the username taken', async () => {
    const { t, admin } = await app();
    const sam = await addPerson(t, admin, 'sam');
    await client(t.app, sam.cookie)('PATCH', '/api/me', { displayName: 'Sam Rivera', email: 'sam@example.com' });
    t.ctx.db.prepare(`UPDATE users SET discord_user_id = '123456789012345678', ntfy_topic = 'sam-alerts', notify_prefs = '{"assigned":false}' WHERE id = ?`).run(sam.id);
    await client(t.app, admin)('PATCH', `/api/users/${sam.id}`, { tagScope: [labelId(t.ctx, 'Hardware')] });
    const card = (await client(t.app, sam.cookie)('POST', '/api/cards', { title: 'Garage door sensor' })).json();
    expect((await client(t.app, sam.cookie)('PUT', `/api/cards/${card.id}/watch`)).statusCode).toBe(200);
    t.ctx.db.prepare(`INSERT INTO notifications (user_id, card_id, type, created_at) VALUES (?, ?, 'assigned', ?)`).run(sam.id, card.id, '2026-10-10T15:00:00.000Z');
    const otherDevice = await loginAs(t, 'sam');

    expect((await client(t.app, admin)('DELETE', `/api/users/${sam.id}`)).statusCode).toBe(200);

    expect(userRow(t, sam.id)).toMatchObject({
      username: 'sam',
      display_name: 'Sam Rivera',
      email: null,
      role: 'member',
      password_hash: null,
      oidc_issuer: null,
      oidc_subject: null,
      discord_user_id: null,
      ntfy_topic: null,
      notify_prefs: '{}',
      tag_scoped: 0,
      disabled_at: expect.any(String),
      deleted_at: expect.any(String),
    });
    const left = (table: string) => t.ctx.db.prepare(`SELECT count(*) FROM ${table} WHERE user_id = ?`).pluck().get(sam.id);
    for (const table of ['sessions', 'card_watchers', 'notifications', 'user_labels']) expect(left(table), table).toBe(0);

    // Signed out everywhere, and the old name and password lead nowhere.
    for (const cookie of [sam.cookie, otherDevice]) expect((await client(t.app, cookie)('GET', '/api/board')).statusCode).toBe(401);
    const login = await client(t.app)('POST', '/api/auth/login', { username: 'sam', password: PASSWORD });
    expect(login.statusCode).toBe(401);

    // Out of the directory's active people, last, marked deleted. The username can't go to someone
    // new (old @mentions and restores must keep meaning them).
    const people = (await client(t.app, admin)('GET', '/api/users')).json();
    expect(people.at(-1)).toMatchObject({ id: sam.id, username: 'sam', displayName: 'Sam Rivera', email: null, disabled: true, deleted: true, tagScope: null });
    const again = await client(t.app, admin)('POST', '/api/users', { username: 'SAM', displayName: 'New Sam', password: PASSWORD });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: 'username_taken', message: expect.stringContaining('deleted') });
  });

  it('revokes their API tokens for good: a restart doesn’t hand them to the owner', async () => {
    const { t, admin } = await app();
    const sam = await addPerson(t, admin, 'sam');
    const { token, info } = (await client(t.app, sam.cookie)('POST', '/api/tokens', { name: 'Homepage', scope: 'read' })).json();
    const summary = () => t.app.inject({ method: 'GET', url: '/api/v1/summary', headers: { authorization: `Bearer ${token}` } });
    expect((await summary()).statusCode).toBe(200);

    await client(t.app, admin)('DELETE', `/api/users/${sam.id}`);
    expect((await summary()).statusCode).toBe(401);
    const listed = (await client(t.app, admin)('GET', '/api/tokens')).json().find((x: { id: number }) => x.id === info.id);
    expect(listed).toMatchObject({ revokedAt: expect.any(String), owner: { id: sam.id, disabled: true, deleted: true } });

    await bootstrapAuth(t.ctx, null, createLogger({ level: 'silent' }));
    expect(t.ctx.db.prepare('SELECT user_id FROM api_tokens WHERE id = ?').pluck().get(info.id)).toBe(sam.id);
    expect((await summary()).statusCode).toBe(401);
  });

  it('gives their open cards back to nobody, logged; done and trashed cards keep them', async () => {
    const { t, admin } = await app();
    const sam = await addPerson(t, admin, 'sam');
    await client(t.app, sam.cookie)('PATCH', '/api/me', { displayName: 'Sam Rivera' });
    const api = client(t.app, admin);
    const make = async (title: string) => (await api('POST', '/api/cards', { title, assigneeId: sam.id })).json() as { id: number };
    const open = await make('Swap the UPS battery');
    const open2 = await make('Label the patch panel');
    const done = await make('Replace the case fan');
    const trashed = await make('Old idea');
    t.ctx.db.prepare(`UPDATE cards SET completed_at = '2026-10-10T15:00:00.000Z' WHERE id = ?`).run(done.id);
    t.ctx.db.prepare(`UPDATE cards SET deleted_at = '2026-10-10T15:00:00.000Z' WHERE id = ?`).run(trashed.id);

    const res = await api('DELETE', `/api/users/${sam.id}`);
    expect(res.json()).toEqual({ unassigned: 2 });
    const assignee = (id: number) => t.ctx.db.prepare('SELECT assignee_id FROM cards WHERE id = ?').pluck().get(id);
    expect([open, open2, done, trashed].map((c) => assignee(c.id))).toEqual([null, null, sam.id, sam.id]);
    const history = (await api('GET', `/api/cards/${open.id}/activity`)).json() as { type: string; data: unknown; userId: number }[];
    expect(history.find((e) => e.type === 'assigned')).toMatchObject({
      data: { from: sam.id, to: null, fromName: 'Sam Rivera', toName: null },
      userId: ownerId(t),
    });
  });

  it('keeps their name on what they did, marked deleted', async () => {
    const { t, admin } = await app();
    const sam = await addPerson(t, admin, 'sam');
    await client(t.app, sam.cookie)('PATCH', '/api/me', { displayName: 'Sam Rivera' });
    const card = (await client(t.app, admin)('POST', '/api/cards', { title: 'Garage door sensor' })).json();
    const note = (await client(t.app, sam.cookie)('POST', `/api/cards/${card.id}/worklog`, { bodyMd: 'Reseated it' })).json();
    await client(t.app, sam.cookie)('PATCH', `/api/activity/${note.id}`, { bodyMd: 'Reseated the sensor' });

    const before = (await client(t.app, admin)('GET', `/api/cards/${card.id}/activity`)).json();
    expect(before.find((e: { id: number }) => e.id === note.id)).not.toHaveProperty('userDeleted');

    await client(t.app, admin)('DELETE', `/api/users/${sam.id}`);
    const after = (await client(t.app, admin)('GET', `/api/cards/${card.id}/activity`)).json();
    expect(after.find((e: { id: number }) => e.id === note.id)).toMatchObject({ userId: sam.id, userName: 'Sam Rivera', userDeleted: true });
    const created = after.find((e: { type: string }) => e.type === 'created');
    expect(created).toMatchObject({ userName: 'admin' });
    expect(created).not.toHaveProperty('userDeleted');
    const revisions = (await client(t.app, admin)('GET', `/api/activity/${note.id}/revisions`)).json();
    expect(revisions).toMatchObject([{ userId: sam.id, userName: 'Sam Rivera', userDeleted: true }]);
  });
});

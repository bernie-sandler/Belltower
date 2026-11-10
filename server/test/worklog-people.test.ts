// 1.5 people in the history: who did what by name (for everyone, tokens included), and who may
// change a work-log entry: its author or an admin. Entries from before 1.5 have no author, so only
// admins may change those.

import { afterEach, describe, expect, it } from 'vitest';
import { addWorklog } from '../src/services/worklog';
import { addPerson, client, makeApp, setupAndLogin, type TestApp } from './helpers';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.shutdown();
  t = undefined;
});

async function setup() {
  t = await makeApp();
  const admin = await setupAndLogin(t);
  const sam = await addPerson(t, admin, 'sam');
  const kim = await addPerson(t, admin, 'kim');
  const card = (await client(t.app, sam.cookie)('POST', '/api/cards', { title: 'Fans loud' })).json() as { id: number };
  return { t, admin, sam, kim, card };
}

describe('work-log permissions', () => {
  it('the author edits and retracts their own entry', async () => {
    const { t, sam, card } = await setup();
    const note = (await client(t.app, sam.cookie)('POST', `/api/cards/${card.id}/worklog`, { bodyMd: 'Dusted' })).json();
    const edit = await client(t.app, sam.cookie)('PATCH', `/api/activity/${note.id}`, { bodyMd: 'Dusted the fans' });
    expect(edit.statusCode).toBe(200);
    expect(edit.json()).toMatchObject({ bodyMd: 'Dusted the fans', userId: note.userId, userName: 'sam' });
    const retract = await client(t.app, sam.cookie)('PATCH', `/api/activity/${note.id}`, { retracted: true });
    expect(retract.statusCode).toBe(200);
    expect(retract.json().retractedAt).toEqual(expect.any(String));
  });

  it('another member gets 403 and changes nothing', async () => {
    const { t, sam, kim, card } = await setup();
    const note = (await client(t.app, sam.cookie)('POST', `/api/cards/${card.id}/worklog`, { bodyMd: 'Dusted' })).json();
    for (const patch of [{ bodyMd: 'Not what happened' }, { retracted: true }, { occurredAt: '2026-10-10T10:00:00.000Z' }]) {
      const res = await client(t.app, kim.cookie)('PATCH', `/api/activity/${note.id}`, patch);
      expect(res.statusCode, JSON.stringify(patch)).toBe(403);
      expect(res.json()).toMatchObject({ error: 'forbidden', message: expect.stringContaining('wrote this entry') });
    }
    const after = (await client(t.app, kim.cookie)('GET', `/api/cards/${card.id}/activity`)).json().find((e: { id: number }) => e.id === note.id);
    expect(after).toMatchObject({ bodyMd: 'Dusted', editedAt: null, retractedAt: null, revisionCount: 0 });
    // Reading the revisions is for everyone.
    expect((await client(t.app, kim.cookie)('GET', `/api/activity/${note.id}/revisions`)).statusCode).toBe(200);
  });

  it('an admin edits and retracts anyone’s entry, and the revision says who edited it', async () => {
    const { t, admin, sam, card } = await setup();
    const note = (await client(t.app, sam.cookie)('POST', `/api/cards/${card.id}/worklog`, { bodyMd: 'Dusted' })).json();
    const edit = await client(t.app, admin)('PATCH', `/api/activity/${note.id}`, { bodyMd: 'Dusted the fans' });
    expect(edit.statusCode).toBe(200);
    expect(edit.json()).toMatchObject({ userName: 'sam' }); // still Sam's entry
    expect((await client(t.app, admin)('PATCH', `/api/activity/${note.id}`, { retracted: true })).statusCode).toBe(200);
    const revisions = (await client(t.app, sam.cookie)('GET', `/api/activity/${note.id}/revisions`)).json();
    expect(revisions).toMatchObject([{ bodyMd: 'Dusted', userName: 'admin' }]);
  });

  it('an entry without an author (from before 1.5) is admin-only', async () => {
    const { t, admin, sam, card } = await setup();
    const legacy = addWorklog(t.ctx, card.id, { bodyMd: 'Old note' }); // the base context acts as nobody
    expect(legacy).toMatchObject({ userId: null, tokenId: null, userName: null, tokenName: null });

    const res = await client(t.app, sam.cookie)('PATCH', `/api/activity/${legacy.id}`, { bodyMd: 'Mine now' });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/only an admin/i);
    expect((await client(t.app, sam.cookie)('PATCH', `/api/activity/${legacy.id}`, { retracted: true })).statusCode).toBe(403);

    expect((await client(t.app, admin)('PATCH', `/api/activity/${legacy.id}`, { bodyMd: 'Old note, clarified' })).statusCode).toBe(200);
    expect((await client(t.app, admin)('PATCH', `/api/activity/${legacy.id}`, { retracted: true })).statusCode).toBe(200);
  });

  it('a member promoted to admin may change others’ entries; a demoted admin no longer may', async () => {
    const { t, admin, sam, kim, card } = await setup();
    const note = (await client(t.app, sam.cookie)('POST', `/api/cards/${card.id}/worklog`, { bodyMd: 'Dusted' })).json();
    expect((await client(t.app, admin)('PATCH', `/api/users/${kim.id}`, { role: 'admin' })).statusCode).toBe(200);
    expect((await client(t.app, kim.cookie)('PATCH', `/api/activity/${note.id}`, { bodyMd: 'Dusted, checked by Kim' })).statusCode).toBe(200);
    expect((await client(t.app, admin)('PATCH', `/api/users/${kim.id}`, { role: 'member' })).statusCode).toBe(200);
    expect((await client(t.app, kim.cookie)('PATCH', `/api/activity/${note.id}`, { retracted: true })).statusCode).toBe(403);
  });
});

describe('who did what, by name', () => {
  it('names the person and the token for everyone, without them listing tokens', async () => {
    const { t, admin, sam, card } = await setup();
    await client(t.app, sam.cookie)('PATCH', '/api/me', { displayName: 'Sam Ortiz' });
    const history = (await client(t.app, admin)('GET', `/api/cards/${card.id}/activity`)).json();
    expect(history.find((e: { type: string }) => e.type === 'created')).toMatchObject({ userName: 'Sam Ortiz', tokenName: null });

    const { token } = (await client(t.app, admin)('POST', '/api/tokens', { name: 'Kuma' })).json();
    const v1 = await t.app.inject({ method: 'POST', url: '/api/v1/cards', headers: { authorization: `Bearer ${token}` }, payload: { title: 'NAS down' } });
    expect(v1.statusCode).toBe(201);
    expect((await client(t.app, sam.cookie)('GET', '/api/tokens')).json()).toEqual([]); // Sam can't list the admin's tokens…
    const tokenHistory = (await client(t.app, sam.cookie)('GET', `/api/cards/${v1.json().card.id}/activity`)).json();
    expect(tokenHistory[0]).toMatchObject({ type: 'created', userName: 'admin', tokenName: 'Kuma' }); // …but reads who did it

    // A deactivated person keeps their name in the history.
    await client(t.app, admin)('PATCH', `/api/users/${sam.id}`, { disabled: true });
    const later = (await client(t.app, admin)('GET', `/api/cards/${card.id}/activity`)).json();
    expect(later.find((e: { type: string }) => e.type === 'created')).toMatchObject({ userName: 'Sam Ortiz' });
  });
});

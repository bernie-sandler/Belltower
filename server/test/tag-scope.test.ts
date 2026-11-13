// Tag-restricted accounts: a member restricted to some tags sees only cards carrying one of them,
// on every route that reads cards, and can't make board-wide changes. Admins are unaffected.

import { DEFAULT_NOTIFY_PREFS } from '@tt/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { TicketDrafter } from '../src/services/aiDraft';
import { getSubmitSettings, updateSubmitSettings } from '../src/services/settings';
import { listRequestTypes } from '../src/services/requestTypes';
import { addPerson, client, enableTeams, makeApp, setupAndLogin, type TestApp } from './helpers';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.shutdown();
  t = undefined;
});

function upload(app: TestApp, cookie: string, url: string, filename: string, content: Buffer) {
  const boundary = '----ttscope' + Math.random().toString(16).slice(2);
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.app.inject({
    method: 'POST',
    url,
    headers: { cookie, 'x-requested-with': 'tower-tracker', 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
}

/**
 * The owner, a member `sam` restricted to tag A, and cards: `a` (A), `b` (B, with a checklist, a
 * note, a file and a due date; it blocks `a` and is linked to it), `untagged`, a work card `w` (A)
 * with a hidden child `child` (B), and B-tagged cards in the Archive and the Trash.
 */
async function setup(ai?: TicketDrafter) {
  t = await makeApp(ai ? { ai } : {});
  const admin = await setupAndLogin(t);
  enableTeams(t.ctx);
  const api = client(t.app, admin);
  const A = (await api('POST', '/api/labels', { name: 'Alpha', color: '#112233' })).json().id as number;
  const B = (await api('POST', '/api/labels', { name: 'Bravo', color: '#445566' })).json().id as number;
  const sam = await addPerson(t, admin, 'sam');
  expect((await api('PATCH', `/api/users/${sam.id}`, { tagScope: [A] })).json().tagScope).toEqual([A]);

  const card = async (title: string, labelIds: number[], extra: object = {}) =>
    (await api('POST', '/api/cards', { title, labelIds, ...extra })).json() as { id: number; columnId: number };
  const a = await card('Alpha router reboot', [A]);
  const b = await card('Bravo secret quarterly payroll', [B], { dueDate: '2026-10-12', description: 'payroll details' });
  const untagged = await card('Untagged furnace filter', []);
  const w = await card('Alpha migration project', [A], { kind: 'work' });
  const child = await card('Bravo hidden child task', [B], { parentId: w.id });
  const archived = await card('Bravo archived thing', [B]);
  const trashed = await card('Bravo trashed thing', [B]);

  expect((await api('POST', `/api/cards/${b.id}/links`, { otherCardId: a.id, direction: 'blocks' })).statusCode).toBe(200);
  const checklist = (await api('POST', `/api/cards/${b.id}/checklists`, { title: 'Bravo steps' })).json().checklists[0];
  const item = (await api('POST', `/api/checklists/${checklist.id}/items`, { text: 'Bravo step one' })).json().checklists[0].items[0];
  const note = (await api('POST', `/api/cards/${b.id}/worklog`, { bodyMd: 'Bravo note text' })).json();
  expect((await upload(t, admin, `/api/cards/${b.id}/attachments`, 'bravo.log', Buffer.from('bravo log\n'))).statusCode).toBe(200);
  const attachment = (await api('GET', `/api/cards/${b.id}`)).json().attachments[0];
  const done = t.ctx.db.prepare(`SELECT id FROM columns WHERE role = 'done'`).pluck().get() as number;
  await api('POST', `/api/cards/${archived.id}/move`, { toColumnId: done, afterCardId: null });
  await api('POST', `/api/cards/${archived.id}/archive`);
  await api('DELETE', `/api/cards/${trashed.id}`);

  return { t, admin, api, sam, as: client(t.app, sam.cookie), A, B, a, b, untagged, w, child, archived, trashed, checklist, item, note, attachment, done };
}

/** A card's current version, for PATCH bodies. */
const version = (id: number) => t!.ctx.db.prepare('SELECT version FROM cards WHERE id = ?').pluck().get(id) as number;

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

const ids = (list: { id: number }[]) => list.map((c) => c.id).sort((x, y) => x - y);

describe('a tag-restricted member', () => {
  it('sees only cards carrying one of their tags on the board and in lists', async () => {
    const s = await setup();
    const board = (await s.as('GET', '/api/board')).json();
    expect(ids(board.cards)).toEqual([s.a.id, s.w.id]);
    const a = board.cards.find((c: { id: number }) => c.id === s.a.id);
    const w = board.cards.find((c: { id: number }) => c.id === s.w.id);
    // Hidden linked and child cards aren't counted; the hidden blocker still blocks.
    expect(a).toMatchObject({ linkCount: 0, blockedBy: 1 });
    expect(w).toMatchObject({ childCount: 0, childOpen: 0 });

    for (const status of ['board', 'archived', 'trashed', 'live']) {
      const list = (await s.as('GET', `/api/cards?status=${status}`)).json();
      for (const c of list) expect([s.a.id, s.w.id]).toContain(c.id);
    }
    expect((await s.as('GET', '/api/cards?status=live&q=Bravo')).json()).toEqual([]);

    // The admin sees everything.
    expect((await s.api('GET', '/api/board')).json().cards.length).toBe(5);
  });

  it('gets 404 for a hidden card on every card route, and hidden ids in sub-objects', async () => {
    const s = await setup();
    const hidden = [s.b.id, s.untagged.id, s.child.id, s.archived.id, s.trashed.id];
    for (const id of hidden) {
      const calls: [Method, string, unknown?][] = [
        ['GET', `/api/cards/${id}`],
        ['PATCH', `/api/cards/${id}`, { title: 'x', expectedVersion: version(id) }],
        ['POST', `/api/cards/${id}/move`, { toColumnId: s.a.columnId, afterCardId: null }],
        ['POST', `/api/cards/${id}/complete`, { includeChildren: false }],
        ['DELETE', `/api/cards/${id}`],
        ['POST', `/api/cards/${id}/undelete`],
        ['POST', `/api/cards/${id}/archive`],
        ['POST', `/api/cards/${id}/restore`],
        ['GET', `/api/cards/${id}/status-link`],
        ['GET', `/api/cards/${id}/activity`],
        ['GET', `/api/cards/${id}/similar`],
        ['PUT', `/api/cards/${id}/watch`],
        ['DELETE', `/api/cards/${id}/watch`],
        ['POST', `/api/cards/${id}/checklists`, { title: 'x' }],
        ['PUT', `/api/cards/${id}/checklists/order`, { ids: [s.checklist.id] }],
        ['POST', `/api/cards/${id}/links`, { otherCardId: s.a.id, direction: 'relates' }],
        ['POST', `/api/cards/${s.a.id}/links`, { otherCardId: id, direction: 'relates' }],
        ['POST', `/api/cards/${id}/worklog`, { bodyMd: 'x' }],
        ['POST', '/api/cards/move-many', { cardIds: [id], toColumnId: s.a.columnId, afterCardId: null }],
      ];
      for (const [method, url, body] of calls) {
        const res = await s.as(method, url, body);
        expect(res.statusCode, `${method} ${url}`).toBe(404);
        expect(res.body).not.toMatch(/Bravo|Untagged/);
      }
    }
    const byChildId: [Method, string, unknown?][] = [
      ['PATCH', `/api/checklists/${s.checklist.id}`, { title: 'x' }],
      ['DELETE', `/api/checklists/${s.checklist.id}`],
      ['POST', `/api/checklists/${s.checklist.id}/items`, { text: 'x' }],
      ['PATCH', `/api/checklist-items/${s.item.id}`, { state: 'done' }],
      ['DELETE', `/api/checklist-items/${s.item.id}`],
      ['GET', `/api/attachments/${s.attachment.id}`],
      ['GET', `/api/attachments/${s.attachment.id}/text`],
      ['DELETE', `/api/attachments/${s.attachment.id}`],
      ['GET', `/api/activity/${s.note.id}/revisions`],
      ['PATCH', `/api/activity/${s.note.id}`, { bodyMd: 'x' }],
    ];
    for (const [method, url, body] of byChildId) {
      const res = await s.as(method, url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.body).not.toMatch(/Bravo/);
    }
    // The admin can read them.
    expect((await s.api('GET', `/api/attachments/${s.attachment.id}`)).statusCode).toBe(200);
    expect((await s.api('GET', `/api/cards/${s.b.id}/status-link`)).statusCode).toBe(200);
    expect((await s.api('GET', `/api/activity/${s.note.id}/revisions`)).statusCode).toBe(200);
  });

  it('never sees hidden cards through a visible one: detail, history, blocked errors, moves', async () => {
    const s = await setup();
    const a = (await s.as('GET', `/api/cards/${s.a.id}`)).json();
    expect(a.links).toEqual([]);
    expect((await s.as('GET', `/api/cards/${s.w.id}`)).json().children).toEqual([]);
    const history = JSON.stringify((await s.as('GET', `/api/cards/${s.a.id}/activity`)).json());
    expect(history).toContain('Hidden ticket');
    expect(history).not.toMatch(/Bravo/);
    expect(JSON.stringify((await s.api('GET', `/api/cards/${s.a.id}/activity`)).json())).toMatch(/Bravo/);

    const blocked = await s.as('POST', `/api/cards/${s.a.id}/complete`, { includeChildren: false });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.body).not.toMatch(/Bravo/);
    const moved = await s.as('POST', `/api/cards/${s.a.id}/move`, { toColumnId: s.done, afterCardId: null });
    expect(moved.statusCode).toBe(409);
    expect(moved.body).not.toMatch(/Bravo|#\d+ “/);

    // A hidden card is no anchor, and move answers only list visible cards.
    expect((await s.as('POST', `/api/cards/${s.w.id}/move`, { toColumnId: s.a.columnId, afterCardId: s.b.id })).statusCode).toBe(400);
    const ok = (await s.as('POST', `/api/cards/${s.w.id}/move`, { toColumnId: s.a.columnId, afterCardId: null })).json();
    for (const list of Object.values(ok.orders) as number[][]) for (const id of list) expect([s.a.id, s.w.id]).toContain(id);
  });

  it('search, similar and calendar leave hidden cards out', async () => {
    const s = await setup();
    expect(JSON.stringify((await s.as('GET', '/api/search?q=Bravo')).json())).not.toMatch(/Bravo/);
    expect(JSON.stringify((await s.as('GET', '/api/search?q=payroll')).json())).not.toMatch(/payroll/i);
    expect(JSON.stringify((await s.api('GET', '/api/search?q=payroll')).json())).toMatch(/payroll/i);
    expect(JSON.stringify((await s.as('GET', '/api/similar?title=Bravo%20secret%20quarterly%20payroll')).json())).not.toMatch(/Bravo/);
    expect(JSON.stringify((await s.as('GET', '/api/calendar?from=2026-10-01&to=2026-10-31')).json())).not.toMatch(/Bravo/);
    expect(JSON.stringify((await s.api('GET', '/api/calendar?from=2026-10-01&to=2026-10-31')).json())).toMatch(/Bravo/);
  });

  it('their token is restricted too: v1 summary counts only visible tickets', async () => {
    const s = await setup();
    const token = (await s.as('POST', '/api/tokens', { name: 'Sam script', scope: 'read' })).json().token as string;
    const adminToken = (await s.api('POST', '/api/tokens', { name: 'Admin script', scope: 'read' })).json().token as string;
    const summary = async (tok: string) =>
      (await s.t.app.inject({ method: 'GET', url: '/api/v1/summary', headers: { authorization: `Bearer ${tok}` } })).json();
    const mine = await summary(token);
    const all = await summary(adminToken);
    expect(JSON.stringify(mine)).not.toEqual(JSON.stringify(all));
    expect(mine.open).toBeLessThan(all.open);
  });

  it('only hears about cards they can see, and the bell forgets a card that loses their tag', async () => {
    const s = await setup();
    await s.as('PUT', `/api/cards/${s.a.id}/watch`);
    // Even as a watcher of a hidden card (watching from before the restriction), nothing arrives.
    s.t.ctx.db.prepare('INSERT OR IGNORE INTO card_watchers (card_id, user_id, created_at) VALUES (?, ?, ?)').run(s.b.id, s.sam.id, '2026-10-10T15:00:00.000Z');
    await s.api('POST', `/api/cards/${s.a.id}/worklog`, { bodyMd: 'Alpha note' });
    await s.api('POST', `/api/cards/${s.b.id}/worklog`, { bodyMd: 'Another Bravo note' });
    await s.api('PATCH', `/api/cards/${s.b.id}`, { expectedVersion: version(s.b.id), assigneeId: null });
    const bell = (await s.as('GET', '/api/notifications')).json();
    expect(bell.items.map((n: { cardId: number }) => n.cardId)).toEqual([s.a.id]);
    expect(bell.unread).toBe(1);

    // The admin takes tag A off: the notification leaves the bell and the unread count.
    await s.api('PATCH', `/api/cards/${s.a.id}`, { expectedVersion: version(s.a.id), labelIds: [] });
    const after = (await s.as('GET', '/api/notifications')).json();
    expect(after.items).toEqual([]);
    expect(after.unread).toBe(0);
  });

  it('a submit-page ticket carrying their tag reaches them; nobody who can’t see it is told', async () => {
    const s = await setup();
    const kim = await addPerson(s.t, s.admin, 'kim'); // restricted to B: can't see an A ticket
    await s.api('PATCH', `/api/users/${kim.id}`, { tagScope: [s.B] });
    for (const who of [s.sam, kim]) {
      await client(s.t.app, who.cookie)('PUT', '/api/me/notifications', {
        discordUserId: null,
        ntfyTopic: null,
        prefs: { ...DEFAULT_NOTIFY_PREFS, submitted: { inApp: true, discord: false, ntfy: false }, new_unassigned: { inApp: true, discord: false, ntfy: false } },
      });
    }
    updateSubmitSettings(s.t.ctx, { enabled: true, columnId: null, pageTitle: 'Report a problem', intro: '' });
    const key = getSubmitSettings(s.t.ctx).key!;
    const plex = listRequestTypes(s.t.ctx).find((x) => x.name === 'Plex')!;
    // Every ticket of this request type gets tag A.
    s.t.ctx.db.prepare('INSERT INTO request_type_labels (request_type_id, label_id) VALUES (?, ?)').run(plex.id, s.A);
    const boundary = `----tt${Math.random().toString(16).slice(2)}`;
    const data = { typeId: plex.id, summary: 'stutters', description: 'Freezes', answers: { title: 'Interstellar', media: 'Movie', device: 'Roku' } };
    const submitted = await s.t.app.inject({
      method: 'POST',
      url: `/api/public/submit/${key}`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-requested-with': 'tower-tracker' },
      payload: `--${boundary}\r\nContent-Disposition: form-data; name="data"\r\n\r\n${JSON.stringify(data)}\r\n--${boundary}--\r\n`,
    });
    expect(submitted.statusCode).toBe(201);
    const ticket = s.t.ctx.db.prepare(`SELECT id FROM cards WHERE source_ref = 'submit' ORDER BY id DESC`).pluck().get() as number;
    const bell = (await s.as('GET', '/api/notifications')).json();
    expect(bell.items.map((n: { cardId: number }) => n.cardId)).toContain(ticket);
    expect(s.t.ctx.db.prepare('SELECT count(*) FROM notifications WHERE user_id = ? AND card_id = ?').pluck().get(kim.id, ticket)).toBe(0);
    expect((await s.as('GET', '/api/board')).json().cards.map((c: { id: number }) => c.id)).toContain(ticket);
  });

  it('cards they create get their tags; they can drop their own tag (the card leaves their view)', async () => {
    const s = await setup();
    const made = (await s.as('POST', '/api/cards', { title: 'Sam made this' })).json();
    expect(made.labelIds).toEqual([s.A]);
    const withB = (await s.as('POST', '/api/cards', { title: 'Sam made this too', labelIds: [s.B] })).json();
    expect(withB.labelIds.sort()).toEqual([s.A, s.B].sort());
    // Filing under a hidden work card is refused like a missing one.
    const hiddenWork = (await s.api('POST', '/api/cards', { title: 'Bravo work', kind: 'work', labelIds: [s.B] })).json();
    expect((await s.as('POST', '/api/cards', { title: 'x', parentId: hiddenWork.id })).statusCode).toBe(400);

    const dropped = await s.as('PATCH', `/api/cards/${made.id}`, { expectedVersion: version(made.id), labelIds: [s.B] });
    expect(dropped.statusCode).toBe(200);
    expect((await s.as('GET', `/api/cards/${made.id}`)).statusCode).toBe(404);
  });

  it('can’t be given a card they can’t see', async () => {
    const s = await setup();
    const refused = await s.api('PATCH', `/api/cards/${s.b.id}`, { expectedVersion: version(s.b.id), assigneeId: s.sam.id });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe('assignee_cant_see');
    expect((await s.api('POST', '/api/cards', { title: 'x', labelIds: [s.B], assigneeId: s.sam.id })).statusCode).toBe(400);
    expect((await s.api('PATCH', `/api/cards/${s.a.id}`, { expectedVersion: version(s.a.id), assigneeId: s.sam.id })).statusCode).toBe(200);
    // Adding the tag in the same change is fine.
    expect((await s.api('PATCH', `/api/cards/${s.b.id}`, { expectedVersion: version(s.b.id), assigneeId: s.sam.id, labelIds: [s.A, s.B] })).statusCode).toBe(200);
  });

  it('can’t make board-wide changes', async () => {
    const s = await setup();
    const columns = (await s.api('GET', '/api/board')).json().columns as { id: number }[];
    const labels = (await s.api('GET', '/api/board')).json().labels as { id: number }[];
    const calls: [Method, string, unknown?][] = [
      ['POST', '/api/labels', { name: 'New', color: '#123456' }],
      ['PATCH', `/api/labels/${s.A}`, { name: 'Renamed' }],
      ['DELETE', `/api/labels/${s.A}`],
      ['PUT', '/api/labels/order', { ids: labels.map((l) => l.id).reverse() }],
      ['POST', '/api/columns', { name: 'New column' }],
      ['PATCH', `/api/columns/${columns[0]!.id}`, { name: 'Renamed' }],
      ['DELETE', `/api/columns/${columns[1]!.id}`],
      ['PUT', '/api/columns/order', { ids: columns.map((c) => c.id).reverse() }],
      ['PUT', '/api/board/blocked-column', { columnId: columns[1]!.id }],
      ['POST', '/api/cards/archive-done'],
      ['POST', `/api/columns/${columns[0]!.id}/sort-by-priority`],
      ['POST', '/api/templates', { title: 'x', intervalUnit: 'day', intervalCount: 1, startDate: '2026-10-11' }],
    ];
    for (const [method, url, body] of calls) {
      const res = await s.as(method, url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error).toBe('restricted');
    }
    // Members who aren't restricted still can.
    const lee = await addPerson(s.t, s.admin, 'lee');
    expect((await client(s.t.app, lee.cookie)('POST', '/api/labels', { name: 'New', color: '#123456' })).statusCode).toBe(200);
  });

  it('fails closed: with every tag deleted they see nothing and can’t create cards', async () => {
    const s = await setup();
    expect((await s.api('DELETE', `/api/labels/${s.A}`)).statusCode).toBe(204);
    const me = (await s.as('GET', '/api/me')).json();
    expect(me.tagScope).toEqual([]);
    expect((await s.as('GET', '/api/board')).json().cards).toEqual([]);
    expect((await s.as('GET', '/api/cards?status=live')).json()).toEqual([]);
    expect((await s.as('POST', '/api/cards', { title: 'x' })).statusCode).toBe(403);
  });

  it('admins and the owner can’t be restricted; making someone an admin lifts it', async () => {
    const s = await setup();
    const users = (await s.api('GET', '/api/users')).json() as { id: number; isOwner: boolean; tagScope: number[] | null }[];
    const owner = users.find((u) => u.isOwner)!;
    expect((await s.api('PATCH', `/api/users/${owner.id}`, { tagScope: [s.A] })).statusCode).toBe(409);
    expect((await s.api('PATCH', `/api/users/${s.sam.id}`, { role: 'admin', tagScope: [s.A] })).statusCode).toBe(409);
    expect((await s.api('PATCH', `/api/users/${s.sam.id}`, { tagScope: [999] })).statusCode).toBe(400);
    expect((await s.api('PATCH', `/api/users/${s.sam.id}`, { role: 'admin' })).json().tagScope).toBeNull();
    expect((await s.api('PATCH', `/api/users/${s.sam.id}`, { role: 'member' })).json().tagScope).toBeNull();
    expect((await s.as('GET', '/api/board')).json().cards.length).toBe(5);
    // Members can't restrict anyone.
    expect((await s.as('PATCH', `/api/users/${s.sam.id}`, { tagScope: [s.A] })).statusCode).toBe(403);
  });

  it('history doesn’t keep the ids of hidden cards either', async () => {
    const s = await setup();
    const history = (await s.as('GET', `/api/cards/${s.a.id}/activity`)).json() as { type: string; data: Record<string, unknown> }[];
    const linked = history.find((e) => e.type === 'linked')!;
    expect(linked.data).toMatchObject({ otherId: null, otherTitle: 'Hidden ticket' });
    const child = (await s.api('POST', '/api/cards', { title: 'Bravo kid', labelIds: [s.B], parentId: s.w.id })).json();
    void child;
    const w = (await s.as('GET', `/api/cards/${s.w.id}/activity`)).json() as { type: string; data: { child?: { id: unknown } } }[];
    for (const e of w.filter((x) => x.type === 'child_added')) expect(e.data.child!.id).toBeNull();
  });

  it('the directory shows a restriction only to admins and to the person themselves', async () => {
    const s = await setup();
    const kim = await addPerson(s.t, s.admin, 'kim');
    await s.api('PATCH', `/api/users/${kim.id}`, { tagScope: [s.B] });
    const seenBySam = (await s.as('GET', '/api/users')).json() as { id: number; tagScope: number[] | null }[];
    expect(seenBySam.find((u) => u.id === s.sam.id)!.tagScope).toEqual([s.A]);
    expect(seenBySam.find((u) => u.id === kim.id)!.tagScope).toBeNull();
    const seenByAdmin = (await s.api('GET', '/api/users')).json() as { id: number; tagScope: number[] | null }[];
    expect(seenByAdmin.find((u) => u.id === kim.id)!.tagScope).toEqual([s.B]);
  });

  it('a card that loses the assignee’s tag is unassigned, and logged', async () => {
    const s = await setup();
    await s.api('PATCH', `/api/cards/${s.a.id}`, { expectedVersion: version(s.a.id), assigneeId: s.sam.id });
    const after = (await s.api('PATCH', `/api/cards/${s.a.id}`, { expectedVersion: version(s.a.id), labelIds: [s.B] })).json();
    expect(after.assigneeId).toBeNull();
    const history = (await s.api('GET', `/api/cards/${s.a.id}/activity`)).json() as { type: string; data: Record<string, unknown> }[];
    expect(history.find((e) => e.type === 'assigned')!.data).toMatchObject({ from: s.sam.id, to: null });
  });

  it('narrowing someone’s tags takes them off the cards they can no longer see', async () => {
    const s = await setup();
    await s.api('PATCH', `/api/users/${s.sam.id}`, { tagScope: [s.A, s.B] });
    await s.api('PATCH', `/api/cards/${s.a.id}`, { expectedVersion: version(s.a.id), assigneeId: s.sam.id });
    await s.api('PATCH', `/api/cards/${s.b.id}`, { expectedVersion: version(s.b.id), assigneeId: s.sam.id });
    const res = (await s.api('PATCH', `/api/users/${s.sam.id}`, { tagScope: [s.A] })).json();
    expect(res).toMatchObject({ tagScope: [s.A], unassigned: 1 });
    const assignee = (id: number) => s.t.ctx.db.prepare('SELECT assignee_id FROM cards WHERE id = ?').pluck().get(id);
    expect(assignee(s.a.id)).toBe(s.sam.id);
    expect(assignee(s.b.id)).toBeNull();
    const history = (await s.api('GET', `/api/cards/${s.b.id}/activity`)).json() as { type: string; data: Record<string, unknown> }[];
    expect(history.find((e) => e.type === 'assigned' && e.data.to === null)).toBeTruthy();
    expect((await s.api('PATCH', `/api/users/${s.sam.id}`, { displayName: 'Sam R' })).json().unassigned).toBe(0);
  });

  it('links, checklist order, mark-read, Add ticket and import treat hidden cards as missing', async () => {
    const s = await setup();
    const link = (await s.api('GET', `/api/cards/${s.a.id}`)).json().links[0];
    const linkId = link.id as number;
    const del = await s.as('DELETE', `/api/cards/${s.a.id}/links/${linkId}`);
    expect(del.statusCode).toBe(404);
    expect(del.json().message).toBe('Link not found');
    const order = await s.as('PUT', `/api/checklists/${s.checklist.id}/items/order`, { ids: [s.item.id] });
    expect(order.statusCode).toBe(404);
    expect(order.body).not.toMatch(/Bravo/);

    // Mark-read counts only what the bell shows.
    await s.as('PUT', `/api/cards/${s.a.id}/watch`);
    await s.api('POST', `/api/cards/${s.a.id}/worklog`, { bodyMd: 'Alpha note' });
    s.t.ctx.db
      .prepare(`INSERT INTO notifications (user_id, card_id, type, data, created_at) VALUES (?, ?, 'watching', '{}', '2026-10-10T15:00:00.000Z')`)
      .run(s.sam.id, s.b.id);
    expect((await s.as('GET', '/api/notifications')).json().unread).toBe(1);
    expect((await s.as('POST', '/api/notifications/read', { cardId: s.b.id })).json()).toEqual({ unread: 1 });
    expect((await s.as('POST', '/api/notifications/read', { all: true })).json()).toEqual({ unread: 0 });

    // Add ticket: a hidden work card or link target is missing.
    expect((await s.as('POST', '/api/tickets', { title: 'x', parentId: s.w.id })).statusCode).toBe(201);
    const hiddenParent = await s.as('POST', '/api/tickets', { title: 'y', parentId: s.child.id });
    expect(hiddenParent.statusCode).toBe(400);
    expect(hiddenParent.body).not.toMatch(/Bravo/);
    const hiddenLink = await s.as('POST', '/api/tickets', { title: 'z', links: [{ direction: 'relates', cardId: s.b.id }] });
    expect(hiddenLink.statusCode).toBe(404);
    expect(hiddenLink.body).not.toMatch(/Bravo/);

    // Import: a hidden ticket number is unknown, and new tags can't be made.
    const bTicket = s.t.ctx.db.prepare('SELECT ticket_no FROM cards WHERE id = ?').pluck().get(s.b.id) as string;
    const preview = await s.as('POST', '/api/import/cards', { data: [{ title: 'Imported', relatedTo: [bTicket], labels: ['Brand new tag'] }], dryRun: true });
    expect(preview.body).not.toMatch(/Bravo/);
    expect(preview.body).toMatch(/can’t create labels|can't create labels/);
  });

  it('a restricted token: v1 intake and the Uptime Kuma hook only match visible cards, and can’t make tags', async () => {
    const s = await setup();
    const token = (await s.as('POST', '/api/tokens', { name: 'Sam kuma' })).json().token as string;
    const v1 = (url: string, body: unknown) =>
      s.t.app.inject({ method: 'POST', url, payload: body as object, headers: { authorization: `Bearer ${token}` } });
    // A hidden open card with the same dedupe key: a new card, not a note on the hidden one.
    s.t.ctx.db.prepare(`UPDATE cards SET source = 'api', source_ref = 'nas-down' WHERE id = ?`).run(s.b.id);
    const made = await v1('/api/v1/cards', { title: 'NAS down', dedupeKey: 'nas-down' });
    expect(made.statusCode).toBe(201);
    expect(made.json().card.id).not.toBe(s.b.id);
    expect(made.body).not.toMatch(/Bravo/);
    const newTag = await v1('/api/v1/cards', { title: 'With a new tag', labels: ['Never seen before'] });
    expect([400, 403]).toContain(newTag.statusCode);
    expect(newTag.body).toMatch(/create labels/);
    const kuma = await v1('/api/v1/hooks/uptime-kuma', {
      heartbeat: { status: 0, msg: 'down', time: '2026-10-10 10:00:00' },
      monitor: { id: 7, name: 'Plex', url: 'http://tower:32400' },
      msg: '[Plex] down',
    });
    expect(kuma.statusCode).toBeLessThan(300);
    const kumaCard = s.t.ctx.db.prepare(`SELECT id FROM cards WHERE source_ref LIKE 'uptime-kuma:%' ORDER BY id DESC`).pluck().get() as number;
    expect((await s.as('GET', `/api/cards/${kumaCard}`)).json().labelIds).toContain(s.A);
  });

  it('AI drafting never sends hidden cards to the model', async () => {
    const calls: string[] = [];
    const ai: TicketDrafter = {
      model: 'claude-test',
      async complete<T>(_system: string, user: string): Promise<T> {
        calls.push(user);
        throw new Error('stop here');
      },
    };
    const s = await setup(ai);
    await s.as('POST', '/api/ai/draft', { text: 'Plex keeps buffering again' });
    await s.as('POST', '/api/ai/draft-many', { text: 'Plex keeps buffering again' });
    expect(calls.length).toBeGreaterThan(0);
    for (const prompt of calls) {
      // Tag names may be sent (they aren't cards); hidden card titles never are.
      expect(prompt).toMatch(/Alpha router reboot/);
      expect(prompt).not.toMatch(/Bravo secret|Bravo hidden|Bravo archived|Untagged furnace/);
    }
  });
});

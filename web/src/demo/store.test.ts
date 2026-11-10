// The demo's data store: seeding, the API's create/read/update/delete through the same routes the
// app calls, persistence under the versioned key, and reset.

import {
  CSRF_HEADER,
  CSRF_VALUE,
  type ActivityEntry,
  type BoardResponse,
  type CardDetail,
  type MeResponse,
  type SettingsResponse,
  type UserInfo,
} from '@tt/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from './seed';
import { DEMO_SCHEMA_VERSION } from './server/db';
import { dispatch, type DemoResponse, type Method } from './server/routes';
import { DemoStore, memoryStorage, STORAGE_KEY, STORAGE_PREFIX } from './store';

const NOW = new Date('2026-11-07T18:00:00.000Z');
const TZ = 'America/Chicago';

function makeStore(storage: Storage = memoryStorage(), now = NOW) {
  return new DemoStore({ storage, timeZone: TZ, now: () => now, seed: (n, tz) => seedDemo(n, tz, { appUrl: 'https://example.test/Belltower/#' }) });
}

function call(store: DemoStore, method: Method, url: string, body?: unknown): DemoResponse {
  const u = new URL(url, 'https://example.test');
  return dispatch(store, {
    method,
    path: u.pathname,
    query: Object.fromEntries(u.searchParams),
    body,
    form: null,
    headers: new Headers(method === 'GET' ? {} : { [CSRF_HEADER]: CSRF_VALUE }),
  });
}

function ok<T>(res: DemoResponse): T {
  if (res.status >= 400) throw new Error(`${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as T;
}

const board = (store: DemoStore) => ok<BoardResponse>(call(store, 'GET', '/api/board'));

describe('seed', () => {
  let store: DemoStore;
  beforeEach(() => {
    store = makeStore();
  });

  it('fills every column with a lived-in board', () => {
    const b = board(store);
    expect(b.columns.map((c) => c.name)).toEqual(['Triage', 'Backlog', 'In Progress', 'Blocked/Waiting', 'Done']);
    for (const col of b.columns) expect(b.cards.filter((c) => c.columnId === col.id).length, col.name).toBeGreaterThan(0);
    const tickets = b.cards.filter((c) => c.kind === 'ticket');
    expect(tickets.length).toBeGreaterThanOrEqual(15);
    expect(tickets.length).toBeLessThanOrEqual(20);
    expect(b.cards.some((c) => c.kind === 'work' && c.childCount > 0)).toBe(true);
    expect(new Set(tickets.map((c) => c.priority)).size).toBeGreaterThanOrEqual(4); // P0–P3 and none
  });

  it('uses the default labels and has blocked cards parked in Blocked/Waiting', () => {
    const b = board(store);
    expect(b.labels.map((l) => l.name)).toEqual(['Plex', 'Array/Storage', 'Network', 'NPM/Proxy', 'VMs', 'Docker', 'Hardware', 'Unraid OS']);
    const blocked = b.columns.find((c) => c.name === 'Blocked/Waiting')!;
    expect(b.blockedColumnId).toBe(blocked.id);
    const parked = b.cards.filter((c) => c.columnId === blocked.id);
    expect(parked.length).toBeGreaterThan(0);
    expect(parked.every((c) => c.blockedBy > 0)).toBe(true);
  });

  it('spreads ages, and gives tickets from other people and work-log comments', () => {
    const s = store.snapshot();
    const ages = s.cards.map((c) => (NOW.getTime() - Date.parse(c.createdAt)) / 86_400_000);
    expect(Math.max(...ages)).toBeGreaterThan(30);
    expect(Math.min(...ages)).toBeLessThan(1);
    const submitters = s.cards.filter((c) => c.sourceRef === 'submit').map((c) => /_Submitted by (\w+)/.exec(c.descriptionMd)?.[1]);
    expect(submitters.sort()).toEqual(['Jake', 'Priya', 'Sam']);
    expect(s.activity.filter((a) => a.kind === 'worklog').length).toBeGreaterThanOrEqual(8);
    // Ticket numbers follow the creation date, as on the server: "YYMMDD-N".
    expect(s.cards.every((c) => /^\d{6}-\d+$/.test(c.ticketNo ?? ''))).toBe(true);
    expect(s.cards.some((c) => c.archivedAt)).toBe(true);
    expect(s.cards.every((c) => Date.parse(c.updatedAt) <= NOW.getTime())).toBe(true);
  });

  it('signs the visitor in, with a working submit page link', () => {
    const settings = ok<SettingsResponse>(call(store, 'GET', '/api/settings'));
    expect(settings.submit.enabled).toBe(true);
    expect(settings.general.appUrl).toBe('https://example.test/Belltower/#');
    expect(call(store, 'GET', `/api/public/submit/${settings.submit.key}`).status).toBe(200);
    expect(ok<{ authenticated: boolean }>(call(store, 'GET', '/api/auth/status')).authenticated).toBe(true);
  });

  it('shows every checklist mark on the disk 3 card', () => {
    const disk3 = board(store).cards.find((c) => c.title === 'Disk 3 reallocated sectors climbing')!;
    expect(disk3).toMatchObject({ checklistDone: 3, checklistFailed: 1, checklistUnverified: 1, checklistTotal: 5 });
    const items = ok<CardDetail>(call(store, 'GET', `/api/cards/${disk3.id}`)).checklists[0]!.items;
    expect(items.map((i) => i.state)).toEqual(['failed', 'done', 'done', 'unverified', 'open']);
  });
});

describe('CRUD through the routes', () => {
  let store: DemoStore;
  beforeEach(() => {
    store = makeStore();
  });

  it('creates, reads, updates, moves and trashes a card', () => {
    const created = call(store, 'POST', '/api/cards', { title: '  Replace the UPS  ' });
    expect(created.status).toBe(201);
    const card = created.body as CardDetail;
    expect(card.title).toBe('Replace the UPS');
    expect(card.ticketNo).toMatch(/^261107-\d+$/);
    expect(board(store).cards.some((c) => c.id === card.id)).toBe(true);

    const updated = ok<CardDetail>(call(store, 'PATCH', `/api/cards/${card.id}`, { expectedVersion: card.version, priority: 'high' }));
    expect(updated.priority).toBe('high');
    expect(updated.version).toBe(card.version + 1);

    // A stale version is a conflict, like on the server.
    const stale = call(store, 'PATCH', `/api/cards/${card.id}`, { expectedVersion: card.version, title: 'x' });
    expect(stale.status).toBe(409);
    expect((stale.body as { error: string }).error).toBe('version_conflict');

    const inProgress = board(store).columns.find((c) => c.name === 'In Progress')!;
    ok(call(store, 'POST', `/api/cards/${card.id}/move`, { toColumnId: inProgress.id, afterCardId: null }));
    expect(board(store).cards.find((c) => c.id === card.id)!.columnId).toBe(inProgress.id);

    expect(call(store, 'DELETE', `/api/cards/${card.id}`).status).toBe(204);
    expect(board(store).cards.some((c) => c.id === card.id)).toBe(false);
    const trash = ok<{ id: number }[]>(call(store, 'GET', '/api/cards?status=trashed'));
    expect(trash.map((c) => c.id)).toContain(card.id);

    const types = ok<{ type: string }[]>(call(store, 'GET', `/api/cards/${card.id}/activity`)).map((a) => a.type);
    expect(types).toEqual(expect.arrayContaining(['created', 'priority_changed', 'moved', 'deleted']));
  });

  it('rejects the same bad input as the server, with its message format', () => {
    const res = call(store, 'POST', '/api/cards', { title: '' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'validation', message: expect.stringMatching(/^title: /) });
    expect(call(store, 'POST', '/api/labels', { name: 'X', color: '#FFFFFF' }).status).toBe(400); // lowercase hex only
    expect(call(store, 'GET', '/api/cards/abc').status).toBe(404);
  });

  it("won't complete a blocked card, and rolls back everything a failed request changed", () => {
    const b = board(store);
    const blocked = b.cards.find((c) => c.blockedBy > 0)!;
    const before = store.snapshot();
    const res = call(store, 'POST', `/api/cards/${blocked.id}/complete`, { includeChildren: false });
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toBe('blocked');
    expect(store.snapshot()).toEqual(before);
  });

  it('imports cards from JSON in the browser', () => {
    const preview = ok<{ items: { ok: boolean }[]; created: number[] }>(
      call(store, 'POST', '/api/import/cards', { text: '```json\n[{"title":"From the import","labels":["Plex","New label"],"priority":"P1"}]\n```', dryRun: true }),
    );
    expect(preview.items[0]!.ok).toBe(true);
    expect(preview.created).toEqual([]);
    const res = call(store, 'POST', '/api/import/cards', { data: { cards: [{ title: 'From the import' }] }, dryRun: false });
    expect(res.status).toBe(201);
    const id = (res.body as { created: number[] }).created[0]!;
    expect(ok<CardDetail>(call(store, 'GET', `/api/cards/${id}`)).title).toBe('From the import');
  });

  it('answers features that need a server with "Not available in the demo"', () => {
    for (const [method, url] of [
      ['GET', '/api/backup/export.json'],
      ['POST', '/api/settings/discord/test'],
      ['POST', '/api/backup/restore'],
    ] as const) {
      const res = call(store, method, url);
      expect(res.status, url).toBe(400);
      expect(res.body).toMatchObject({ error: 'demo_unavailable', message: expect.stringMatching(/^Not available in the demo/) });
    }
    const someCard = board(store).cards[0]!;
    expect((call(store, 'POST', `/api/cards/${someCard.id}/attachments`).body as { error: string }).error).toBe('demo_unavailable');
  });

  it('needs sign-in, and any password signs back in', () => {
    expect(call(store, 'POST', '/api/auth/logout').status).toBe(204);
    expect(call(store, 'GET', '/api/board').status).toBe(401);
    expect(call(store, 'POST', '/api/auth/login', { password: 'anything' }).status).toBe(204);
    expect(call(store, 'GET', '/api/board').status).toBe(200);
  });

  it('refuses changes without the CSRF header, like the server', () => {
    const res = dispatch(store, { method: 'POST', path: '/api/cards', query: {}, body: { title: 'x' }, form: null, headers: new Headers() });
    expect(res.status).toBe(403);
  });
});

describe('checklist item marks', () => {
  let clock: Date;
  let store: DemoStore;
  beforeEach(() => {
    clock = NOW;
    store = new DemoStore({ storage: memoryStorage(), timeZone: TZ, now: () => clock, seed: (n, tz) => seedDemo(n, tz) });
  });

  /** A new card with a "Restore test" checklist of two items. */
  function setup() {
    const card = ok<CardDetail>(call(store, 'POST', '/api/cards', { title: 'Verify the backups' }));
    const listId = ok<CardDetail>(call(store, 'POST', `/api/cards/${card.id}/checklists`, { title: 'Restore test' })).checklists[0]!.id;
    ok(call(store, 'POST', `/api/checklists/${listId}/items`, { text: 'Restore one file' }));
    const full = ok<CardDetail>(call(store, 'POST', `/api/checklists/${listId}/items`, { text: 'Check the logs' }));
    return { cardId: card.id, listId, itemId: full.checklists[0]!.items[0]!.id };
  }
  const patch = (itemId: number, body: unknown) => ok<CardDetail>(call(store, 'PATCH', `/api/checklist-items/${itemId}`, body));
  const itemOf = (card: CardDetail, id: number) => card.checklists.flatMap((l) => l.items).find((i) => i.id === id)!;
  /** The card's checklist item events, oldest first. */
  const marks = (cardId: number) =>
    ok<ActivityEntry[]>(call(store, 'GET', `/api/cards/${cardId}/activity`))
      .filter((a) => a.type.startsWith('checklist_item_'))
      .reverse();

  it('walks an item through every state, with the counts on the tile and one event each', () => {
    const { cardId, listId, itemId } = setup();
    const start = ok<CardDetail>(call(store, 'GET', `/api/cards/${cardId}`));
    expect(itemOf(start, itemId)).toEqual({ id: itemId, text: 'Restore one file', state: 'open', checked: false, checkedAt: null, position: 0 });
    expect(start).toMatchObject({ checklistDone: 0, checklistFailed: 0, checklistUnverified: 0, checklistTotal: 2 });

    const cycle = [
      ['done', { checklistDone: 1, checklistFailed: 0, checklistUnverified: 0 }],
      ['failed', { checklistDone: 1, checklistFailed: 1, checklistUnverified: 0 }],
      ['unverified', { checklistDone: 0, checklistFailed: 0, checklistUnverified: 1 }],
      ['open', { checklistDone: 0, checklistFailed: 0, checklistUnverified: 0 }],
    ] as const;
    for (const [n, [state, counts]] of cycle.entries()) {
      clock = new Date(NOW.getTime() + (n + 1) * 60_000);
      const card = patch(itemId, { state });
      expect(itemOf(card, itemId), state).toEqual({
        id: itemId,
        text: 'Restore one file',
        state,
        checked: state === 'done',
        checkedAt: state === 'open' ? null : clock.toISOString(),
        position: 0,
      });
      expect(card, state).toMatchObject({ ...counts, checklistTotal: 2 });
      expect(board(store).cards.find((c) => c.id === cardId), state).toMatchObject({ ...counts, checklistTotal: 2 });
    }

    const data = { checklistId: listId, checklist: 'Restore test', itemId, text: 'Restore one file' };
    expect(marks(cardId).map((a) => [a.type, a.data])).toEqual([
      ['checklist_item_checked', data],
      ['checklist_item_marked', { ...data, state: 'failed' }],
      ['checklist_item_marked', { ...data, state: 'unverified' }],
      ['checklist_item_unchecked', data],
    ]);
  });

  it('still takes `checked` from older clients, lets `state` win, and records nothing when unchanged', () => {
    const { cardId, itemId } = setup();
    expect(itemOf(patch(itemId, { checked: true }), itemId)).toMatchObject({ state: 'done', checked: true, checkedAt: NOW.toISOString() });

    clock = new Date(NOW.getTime() + 60_000);
    // Already done: the mark and its time stay, and nothing is recorded.
    expect(itemOf(patch(itemId, { checked: true }), itemId).checkedAt).toBe(NOW.toISOString());
    expect(itemOf(patch(itemId, { state: 'done' }), itemId).checkedAt).toBe(NOW.toISOString());

    expect(itemOf(patch(itemId, { checked: true, state: 'failed' }), itemId)).toMatchObject({ state: 'failed', checked: false });
    expect(itemOf(patch(itemId, { checked: false }), itemId)).toMatchObject({ state: 'open', checked: false, checkedAt: null });
    patch(itemId, { checked: false });
    patch(itemId, { text: 'Restore two files' });
    // A rename and a mark in one request: the event carries the new text.
    expect(itemOf(patch(itemId, { text: 'Restore three files', state: 'unverified' }), itemId)).toMatchObject({
      text: 'Restore three files',
      state: 'unverified',
    });

    expect(marks(cardId).map((a) => a.type)).toEqual([
      'checklist_item_checked',
      'checklist_item_marked',
      'checklist_item_unchecked',
      'checklist_item_marked',
    ]);
    expect(marks(cardId).at(-1)!.data).toMatchObject({ text: 'Restore three files', state: 'unverified' });
    expect(call(store, 'PATCH', `/api/checklist-items/${itemId}`, { state: 'maybe' }).status).toBe(400);
  });
});

describe('people', () => {
  it('seeds the owner (the visitor) and two more people; any login signs in as the owner', () => {
    const store = makeStore();
    expect(ok<MeResponse>(call(store, 'GET', '/api/me'))).toMatchObject({ username: 'admin', isOwner: true, role: 'admin', passwordManagedByEnv: false });
    const users = ok<UserInfo[]>(call(store, 'GET', '/api/users'));
    expect(users.map((u) => [u.username, u.role])).toEqual([
      ['admin', 'admin'],
      ['alex', 'admin'],
      ['jordan', 'member'],
    ]);
    call(store, 'POST', '/api/auth/logout');
    expect(call(store, 'GET', '/api/me').status).toBe(401);
    expect(call(store, 'POST', '/api/auth/login', { username: 'jordan', password: 'anything' }).status).toBe(204);
    expect(ok<MeResponse>(call(store, 'GET', '/api/me')).username).toBe('admin');
    // The owner's own history says who did it; the submit page's tickets don't.
    const s = store.snapshot();
    const owner = s.users.find((u) => u.isOwner)!.id;
    expect(s.activity.filter((a) => a.type === 'worklog').every((a) => a.userId === owner)).toBe(true);
    const submitted = s.cards.find((c) => c.sourceRef === 'submit')!;
    expect(s.activity.find((a) => a.cardId === submitted.id && a.type === 'created')!.userId).toBeNull();
    // A few cards are assigned: three to the visitor (so Mine isn't empty), one each to the others.
    const byUser = (name: string) => s.cards.filter((c) => c.assigneeId === s.users.find((u) => u.username === name)!.id).map((c) => c.title);
    expect(byUser('admin').sort()).toEqual(['Disk 3 reallocated sectors climbing', 'Test HDR playback on the new version', 'Upgrade Plex']);
    expect(byUser('alex')).toEqual(['Set up off-site backups for appdata']);
    expect(byUser('jordan')).toEqual(['Label the patch panel']);
    const patch = s.cards.find((c) => c.title === 'Label the patch panel')!;
    expect(s.activity.filter((a) => a.cardId === patch.id && a.type === 'assigned').map((a) => [a.data.toName, a.userId])).toEqual([['Jordan Lee', owner]]);
  });

  it('applies the server’s rules to people, and refuses admin routes to members', () => {
    const store = makeStore();
    const created = call(store, 'POST', '/api/users', { username: 'Casey', displayName: 'Casey', password: 'long enough password' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ username: 'casey', role: 'member', hasPassword: true });
    expect((call(store, 'POST', '/api/users', { username: 'casey', displayName: 'x', password: 'long enough password' }).body as { error: string }).error).toBe('username_taken');
    const owner = store.snapshot().users.find((u) => u.isOwner)!;
    expect((call(store, 'PATCH', `/api/users/${owner.id}`, { role: 'member' }).body as { error: string }).error).toBe('owner_protected');
    expect(ok<MeResponse>(call(store, 'PATCH', '/api/me', { displayName: 'Demo Owner' })).displayName).toBe('Demo Owner');

    // As a member (the demo itself always signs in the owner).
    const jordan = store.snapshot().users.find((u) => u.username === 'jordan')!;
    store.transaction((ctx) => {
      ctx.s.session.userId = jordan.id;
    }, true);
    expect(call(store, 'PUT', '/api/settings/general', { ticketFormat: '{N}', appUrl: '', claudeModel: '' }).status).toBe(403);
    expect(call(store, 'POST', '/api/users', { username: 'eve', displayName: 'Eve', password: 'long enough password' }).status).toBe(403);
    expect(call(store, 'POST', '/api/cards', { title: 'Member card' }).status).toBe(201);
    const users = ok<UserInfo[]>(call(store, 'GET', '/api/users'));
    expect(users.find((u) => u.username === 'alex')!.email).toBeNull(); // only admins see others' email
  });

  it('names who did what, and lets only the author or an admin change a work-log entry', () => {
    const store = makeStore();
    const card = board(store).cards[0]!;
    const note = ok<ActivityEntry>(call(store, 'POST', `/api/cards/${card.id}/worklog`, { bodyMd: 'Owner’s note' }));
    expect(note).toMatchObject({ userName: 'Admin', userUsername: 'admin', tokenName: null });
    const history = ok<ActivityEntry[]>(call(store, 'GET', `/api/cards/${card.id}/activity`));
    expect(history.every((e) => (e.userId === null ? e.userName === null : typeof e.userName === 'string'))).toBe(true);

    const jordan = store.snapshot().users.find((u) => u.username === 'jordan')!;
    store.transaction((ctx) => {
      ctx.s.session.userId = jordan.id;
    }, true);
    const refused = call(store, 'PATCH', `/api/activity/${note.id}`, { bodyMd: 'Not mine to change' });
    expect(refused.status).toBe(403);
    expect((refused.body as { error: string }).error).toBe('forbidden');
    const own = ok<ActivityEntry>(call(store, 'POST', `/api/cards/${card.id}/worklog`, { bodyMd: 'Jordan’s note' }));
    expect(ok<ActivityEntry>(call(store, 'PATCH', `/api/activity/${own.id}`, { bodyMd: 'Jordan’s note, edited' })).userName).toBe('Jordan Lee');

    // Back as the owner (an admin): anyone's entry, and the revision says who edited it.
    store.transaction((ctx) => {
      ctx.s.session.userId = ctx.s.users.find((u) => u.isOwner)!.id;
    }, true);
    expect(call(store, 'PATCH', `/api/activity/${own.id}`, { retracted: true }).status).toBe(200);
    const retracted = ok<ActivityEntry[]>(call(store, 'GET', `/api/cards/${card.id}/activity`)).find((e) => e.type === 'worklog_retracted');
    expect(retracted).toMatchObject({ data: { entryId: own.id, text: 'Jordan’s note, edited' }, userName: 'Admin' });
    const revisions = ok<{ userName: string | null }[]>(call(store, 'GET', `/api/activity/${own.id}/revisions`));
    expect(revisions.map((r) => r.userName)).toEqual(['Jordan Lee']);
  });
});

describe('assignees', () => {
  it('assigns like the server: logged as assigned, deactivated and unknown people refused', () => {
    const store = makeStore();
    const users = ok<UserInfo[]>(call(store, 'GET', '/api/users'));
    const me = users.find((u) => u.username === 'admin')!;
    const jordan = users.find((u) => u.username === 'jordan')!;
    const card = ok<CardDetail>(call(store, 'POST', '/api/cards', { title: 'Printer jammed', assigneeId: jordan.id }));
    expect(card.assigneeId).toBe(jordan.id);

    const taken = ok<CardDetail>(call(store, 'PATCH', `/api/cards/${card.id}`, { assigneeId: me.id, expectedVersion: card.version }));
    expect(taken).toMatchObject({ assigneeId: me.id, version: card.version + 1 });
    expect(board(store).cards.find((c) => c.id === card.id)!.assigneeId).toBe(me.id);
    const history = ok<ActivityEntry[]>(call(store, 'GET', `/api/cards/${card.id}/activity`)).filter((e) => e.type === 'assigned');
    expect(history.map((e) => [e.data, e.userId])).toEqual([
      [{ from: jordan.id, to: me.id, fromName: 'Jordan Lee', toName: 'Admin' }, me.id],
      [{ from: null, to: jordan.id, fromName: null, toName: 'Jordan Lee' }, me.id],
    ]);
    // Someone else took it first: the stale version gets a 409.
    expect(call(store, 'PATCH', `/api/cards/${card.id}`, { assigneeId: jordan.id, expectedVersion: card.version }).status).toBe(409);

    ok(call(store, 'PATCH', `/api/users/${jordan.id}`, { disabled: true }));
    const refused = call(store, 'PATCH', `/api/cards/${card.id}`, { assigneeId: jordan.id, expectedVersion: taken.version });
    expect([refused.status, (refused.body as { error: string }).error]).toEqual([400, 'assignee_disabled']);
    expect((call(store, 'PATCH', `/api/cards/${card.id}`, { assigneeId: 999, expectedVersion: taken.version }).body as { error: string }).error).toBe('invalid_assignee');
    expect(ok<CardDetail>(call(store, 'PATCH', `/api/cards/${card.id}`, { assigneeId: null, expectedVersion: taken.version })).assigneeId).toBeNull();
  });
});

describe('persistence and reset', () => {
  it('saves under a namespaced, versioned key and loads it back', () => {
    const storage = memoryStorage();
    const a = makeStore(storage);
    expect(STORAGE_KEY).toBe(`${STORAGE_PREFIX}v${DEMO_SCHEMA_VERSION}`);
    const card = ok<CardDetail>(call(a, 'POST', '/api/cards', { title: 'Kept across reloads' }));
    const b = makeStore(storage);
    expect(board(b).cards.some((c) => c.id === card.id && c.title === 'Kept across reloads')).toBe(true);
  });

  it('reseeds instead of crashing on data from another version, and drops it', () => {
    const storage = memoryStorage();
    storage.setItem(`${STORAGE_PREFIX}v0`, JSON.stringify({ old: true }));
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: DEMO_SCHEMA_VERSION + 1, cards: 'not an array' }));
    const store = makeStore(storage);
    expect(board(store).cards.length).toBeGreaterThan(15);
    expect(storage.getItem(`${STORAGE_PREFIX}v0`)).toBeNull();
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!).version).toBe(DEMO_SCHEMA_VERSION);

    storage.setItem(STORAGE_KEY, '{not json');
    expect(board(makeStore(storage)).cards.length).toBeGreaterThan(15);
  });

  it('reset throws away changes and seeds again', () => {
    const storage = memoryStorage();
    const store = makeStore(storage);
    const seeded = board(store).cards.length;
    ok(call(store, 'POST', '/api/cards', { title: 'Temporary' }));
    call(store, 'POST', '/api/auth/logout');
    expect(store.signedIn()).toBe(false);
    store.reset();
    expect(store.signedIn()).toBe(true);
    expect(board(store).cards.length).toBe(seeded);
    expect(board(store).cards.some((c) => c.title === 'Temporary')).toBe(false);
    expect(board(makeStore(storage)).cards.some((c) => c.title === 'Temporary')).toBe(false);
  });

  it('keeps the old data when the browser refuses to save', () => {
    const storage = memoryStorage();
    makeStore(storage);
    const full = memoryStorage();
    full.setItem(STORAGE_KEY, storage.getItem(STORAGE_KEY)!);
    full.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError');
    };
    const stuck = makeStore(full);
    const res = call(stuck, 'POST', '/api/cards', { title: 'Will not fit' });
    expect(res.status).toBe(507);
    expect(board(stuck).cards.some((c) => c.title === 'Will not fit')).toBe(false);
  });
});

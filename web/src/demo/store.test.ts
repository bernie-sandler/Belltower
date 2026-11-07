// The demo's data store: seeding, the API's create/read/update/delete through the same routes the
// app calls, persistence under the versioned key, and reset.

import { CSRF_HEADER, CSRF_VALUE, type BoardResponse, type CardDetail, type SettingsResponse } from '@tt/shared';
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

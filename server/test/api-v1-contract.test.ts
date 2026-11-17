// The /api/v1 contract (docs/API-V1.md) is frozen for 1.x. These tests pin the documented shapes:
// if one fails, the change breaks scripts and monitors in the field. Add to the API instead.

import { API_TICKETS_PAGE } from '@tt/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { V1_LIMIT } from '../src/http/routes/v1';
import { listRequestTypes } from '../src/services/requestTypes';
import { getSubmitSettings, updateSubmitSettings } from '../src/services/settings';
import { submitTicket } from '../src/services/submit';
import { client, makeApp, setupAndLogin, T0, type TestApp } from './helpers';

let t: TestApp;
afterEach(() => t?.shutdown());

async function setup(canComplete = true) {
  t = await makeApp();
  const c = client(t.app, await setupAndLogin(t));
  // No scope: tokens created the 1.2 way are full tokens.
  const { token } = (await c('POST', '/api/tokens', { name: 'Contract', canComplete })).json();
  const v1 = (url: string, body: unknown, auth = `Bearer ${token}`) =>
    t.app.inject({ method: 'POST', url, payload: body as object, headers: auth ? { authorization: auth } : {} });
  const get = (url: string, auth = `Bearer ${token}`) => t.app.inject({ method: 'GET', url, headers: auth ? { authorization: auth } : {} });
  return { c, v1, get, token };
}

const CARD_KEYS = ['columnId', 'completedAt', 'id', 'ticketNo', 'title'];
const TICKET_KEYS = [
  'archivedAt',
  'column',
  'completedAt',
  'createdAt',
  'deletedAt',
  'due',
  'id',
  'labels',
  'priority',
  'resolution',
  'severity',
  'source',
  'state',
  'submitRef',
  'submitter',
  'ticketNo',
  'title',
  'updatedAt',
];
const SUMMARY_KEYS = [
  'byPriority',
  'bySeverity',
  'completed7d',
  'completedToday',
  'dueToday',
  'generatedAt',
  'inProgress',
  'oldestOpenDays',
  'open',
  'overdue',
  'received',
  'urgent',
  'waiting',
];

describe('/api/v1 contract', () => {
  it('cards: created → updated → recovered/resolved → ignored, with the documented shapes', async () => {
    const { v1 } = await setup();
    const created = await v1('/api/v1/cards', { title: 'Backup failed', dedupeKey: 'backup:nightly', priority: 'P1' });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.status).toBe('created');
    expect(Object.keys(body.card).sort()).toEqual(CARD_KEYS);
    expect(body.card).toMatchObject({ title: 'Backup failed', completedAt: null });
    expect(body.card.ticketNo).toMatch(/^\d{6}-\d+$/);

    const again = await v1('/api/v1/cards', { title: 'Backup failed', dedupeKey: 'backup:nightly' });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ status: 'updated', card: { id: body.card.id } });

    const resolved = (await v1('/api/v1/cards', { dedupeKey: 'backup:nightly', event: 'resolved' })).json();
    expect(resolved.status).toBe('resolved');
    expect(resolved.card.completedAt).toEqual(expect.any(String));

    expect((await v1('/api/v1/cards', { dedupeKey: 'backup:nightly', event: 'resolved' })).json()).toEqual({ status: 'ignored', card: null });
    // Done: the next problem with the same key opens a new ticket.
    const next = (await v1('/api/v1/cards', { title: 'Backup failed', dedupeKey: 'backup:nightly' })).json();
    expect(next.status).toBe('created');
    expect(next.card.id).not.toBe(body.card.id);
  });

  it('a token that may not complete tickets only notes the recovery', async () => {
    const { v1 } = await setup(false);
    await v1('/api/v1/cards', { title: 'NAS offline', dedupeKey: 'nas' });
    const r = (await v1('/api/v1/cards', { dedupeKey: 'nas', event: 'resolved' })).json();
    expect(r).toMatchObject({ status: 'recovered', card: { completedAt: null } });
  });

  it('errors: {error, message} with the documented codes', async () => {
    const { v1 } = await setup();
    const noToken = await v1('/api/v1/cards', { title: 'x' }, '');
    expect(noToken.statusCode).toBe(401);
    expect(noToken.json()).toMatchObject({ error: 'unauthenticated', message: expect.any(String) });
    expect((await v1('/api/v1/cards', { title: 'x' }, 'Bearer tt_wrong')).statusCode).toBe(401);

    const invalid = await v1('/api/v1/cards', { description: 'no title', priority: 'P9' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: 'validation', message: expect.any(String), errors: expect.any(Array) });
    expect(invalid.json().errors.length).toBe(2);

    expect((await v1('/api/v1/cards', { event: 'resolved' })).json()).toMatchObject({ error: 'validation' });
    expect((await v1('/api/v1/cards', { title: 'x'.repeat(3 * 1024 * 1024) })).statusCode).toBe(413);
  });

  it('rate limits per token with Retry-After', async () => {
    const { v1 } = await setup();
    for (let i = 0; i < V1_LIMIT.max; i++) await v1('/api/v1/cards', { dedupeKey: 'k', event: 'resolved' });
    const limited = await v1('/api/v1/cards', { dedupeKey: 'k', event: 'resolved' });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: 'rate_limited', retryAfterSec: expect.any(Number) });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('Uptime Kuma hook: test button, down, up', async () => {
    const { v1 } = await setup();
    expect((await v1('/api/v1/hooks/uptime-kuma', { msg: 'Testing' })).json()).toEqual({ status: 'ignored', card: null, test: true });
    const monitor = { id: 7, name: 'Plex', url: 'http://plex:32400' };
    const down = await v1('/api/v1/hooks/uptime-kuma?labels=Monitoring&priority=P2', { monitor, heartbeat: { status: 0, msg: 'timeout' } });
    expect(down.statusCode).toBe(201);
    expect(down.json()).toMatchObject({ status: 'created', card: { title: 'Plex is down' } });
    expect((await v1('/api/v1/hooks/uptime-kuma', { monitor, heartbeat: { status: 1, msg: 'OK' } })).json().status).toBe('resolved');
    expect((await v1('/api/v1/hooks/uptime-kuma', { monitor, heartbeat: { status: 2 } })).json().status).toBe('ignored');
  });

  it('summary: the documented counts, for full and read-only tokens', async () => {
    const { c, v1, get } = await setup();
    await v1('/api/v1/cards', { title: 'Backup failed', priority: 'P1' });
    const res = await get('/api/v1/summary');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(SUMMARY_KEYS);
    expect(body).toMatchObject({ open: 1, received: 1, inProgress: 0, waiting: 0, urgent: 1, oldestOpenDays: 0 });
    expect(body.byPriority).toEqual({ P0: 0, P1: 1, P2: 0, P3: 0, none: 0 });
    expect(body.bySeverity).toEqual({ S1: 0, S2: 0, S3: 0, S4: 0, none: 1 });
    expect(body.generatedAt).toEqual(expect.any(String));

    const read = (await c('POST', '/api/tokens', { name: 'Homepage', scope: 'read' })).json().token;
    expect((await get('/api/v1/summary', `Bearer ${read}`)).json()).toEqual(body);
    expect((await get('/api/v1/summary', '')).statusCode).toBe(401);
  });

  it('read-only tokens get 403 forbidden on anything but GET, and never complete tickets', async () => {
    const { c, v1 } = await setup();
    const created = (await c('POST', '/api/tokens', { name: 'Homepage', scope: 'read', canComplete: true })).json();
    expect(created.info).toMatchObject({ scope: 'read', canComplete: false });
    for (const url of ['/api/v1/cards', '/api/v1/hooks/uptime-kuma']) {
      const res = await v1(url, { title: 'x', dedupeKey: 'k' }, `Bearer ${created.token}`);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'forbidden', message: expect.any(String) });
    }
    expect((await c('GET', '/api/tokens')).json().map((tk: { name: string; scope: string }) => [tk.name, tk.scope])).toEqual([
      ['Homepage', 'read'],
      ['Contract', 'full'],
    ]);
    const head = await t.app.inject({ method: 'HEAD', url: '/api/v1/summary', headers: { authorization: `Bearer ${created.token}` } });
    expect(head.statusCode).toBe(200);
  });

  it('reading tickets: lookup by ticket number or id, with the documented shape', async () => {
    const { c, v1, get } = await setup();
    const created = (await v1('/api/v1/cards', { title: 'Plex buffering', priority: 'P2', severity: 'S3', labels: ['Media'], due: '2026-10-20' })).json();
    const { id, ticketNo } = created.card;

    const byNo = await get(`/api/v1/cards/${ticketNo}`);
    expect(byNo.statusCode).toBe(200);
    const ticket = byNo.json();
    expect(Object.keys(ticket).sort()).toEqual(TICKET_KEYS);
    expect(ticket).toMatchObject({
      id,
      ticketNo,
      title: 'Plex buffering',
      state: 'received',
      resolution: null,
      priority: 'P2',
      severity: 'S3',
      labels: ['Media'],
      due: '2026-10-20',
      createdAt: T0,
      updatedAt: T0,
      completedAt: null,
      archivedAt: null,
      deletedAt: null,
      source: 'api',
      submitter: null,
      submitRef: null,
    });
    expect(ticket.column).toEqual({ id: expect.any(Number), name: expect.any(String) });
    expect((await get(`/api/v1/cards/${id}`)).json()).toEqual(ticket);
    expect((await get(`/api/v1/cards/${ticketNo.toLowerCase()}`)).json().id).toBe(id);

    t.clock.advance(60_000);
    await c('POST', `/api/cards/${id}/complete`, { resolution: { reason: 'Fixed', note: 'private note' } });
    const done = (await get(`/api/v1/cards/${ticketNo}`)).json();
    expect(done).toMatchObject({ state: 'done', resolution: 'Fixed', completedAt: expect.any(String) });
    expect(done.updatedAt > T0).toBe(true);
    expect(JSON.stringify(done)).not.toContain('private note');

    for (const ref of ['999999', '000000-1', 'nope']) {
      const missing = await get(`/api/v1/cards/${ref}`);
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ error: 'not_found' });
    }
    const work = (await c('POST', '/api/cards', { title: 'Rebuild NAS', kind: 'work' })).json();
    expect((await get(`/api/v1/cards/${work.id}`)).statusCode).toBe(404);
  });

  it('reading tickets: source tells submit-page tickets apart, with the name typed there', async () => {
    const { c, v1, get } = await setup();
    updateSubmitSettings(t.ctx, { enabled: true, columnId: null, pageTitle: 'Report a problem', intro: '' });
    const key = getSubmitSettings(t.ctx).key!;
    const type = listRequestTypes(t.ctx).find((x) => x.name === 'General')!;
    const answers = Object.fromEntries(
      type.fields
        .filter((f) => f.required)
        .map((f) => [f.key, f.kind === 'choice' ? f.options[0]! : f.kind === 'multi' ? [f.options[0]!] : f.kind === 'yesno' ? true : f.kind === 'datetime' ? '2026-10-10T10:00' : 'x']),
    );
    const file = (name: string, ref?: string) =>
      submitTicket(t.ctx, key, { typeId: type.id, summary: 'No sound', description: 'Silent', answers, name, website: '', ...(ref ? { ref } : {}) }, [], t.dir);
    // Before any submit-page ticket is open, or the dedupeKey would join it.
    const lookalike = (await v1('/api/v1/cards', { title: 'Keyed', dedupeKey: 'submit' })).json().card.ticketNo;
    const named = file('Mum (upstairs)', 'bn1.123.0.1700000000.abc_-').ticketNo!;
    const anonymous = file('').ticketNo!;
    const api = (await v1('/api/v1/cards', { title: 'From a script' })).json().card.ticketNo;
    const manual = (await c('POST', '/api/cards', { title: 'By hand' })).json().ticketNo;

    const pick = async (ref: string) => {
      const { source, submitter, submitRef } = (await get(`/api/v1/cards/${encodeURIComponent(ref)}`)).json();
      return { source, submitter, submitRef };
    };
    expect(await pick(named)).toEqual({ source: 'submit', submitter: 'Mum (upstairs)', submitRef: 'bn1.123.0.1700000000.abc_-' });
    expect(await pick(anonymous)).toEqual({ source: 'submit', submitter: null, submitRef: null });
    expect(await pick(api)).toEqual({ source: 'api', submitter: null, submitRef: null });
    expect(await pick(manual)).toEqual({ source: 'manual', submitter: null, submitRef: null });
    expect(await pick(lookalike)).toEqual({ source: 'api', submitter: null, submitRef: null });
    const list = (await get(`/api/v1/cards?updatedSince=${encodeURIComponent(T0)}`)).json();
    expect(list.cards.map((x: { source: string }) => x.source)).toEqual(['api', 'submit', 'submit', 'api', 'manual']);
  });

  it('reading tickets: custom ticket numbers, URL-encoded, win over ids', async () => {
    const { c, v1, get } = await setup();
    const general = (await c('GET', '/api/settings')).json().general;
    expect((await c('PUT', '/api/settings/general', { ...general, ticketFormat: 'INC/#{N}' })).statusCode).toBe(200);
    const slash = (await v1('/api/v1/cards', { title: 'Slash' })).json().card;
    expect(slash.ticketNo).toBe('INC/#1');
    expect((await get(`/api/v1/cards/${encodeURIComponent('inc/#1')}`)).json().id).toBe(slash.id);

    // A digits-only number ("{N}") is looked up as a ticket number first.
    await c('PUT', '/api/settings/general', { ...general, ticketFormat: '{N}' });
    const other = (await v1('/api/v1/cards', { title: 'Other' })).json().card;
    expect(other.ticketNo).toMatch(/^\d+$/);
    expect(Number(other.ticketNo)).not.toBe(other.id); // else the lookup below proves nothing
    const named = (await get(`/api/v1/cards/${other.ticketNo}`)).json();
    expect(named.ticketNo).toBe(other.ticketNo);
  });

  it('reading tickets: by ids and updatedSince, oldest change first', async () => {
    const { c, v1, get } = await setup();
    const a = (await v1('/api/v1/cards', { title: 'A' })).json().card;
    t.clock.advance(1000);
    const b = (await v1('/api/v1/cards', { title: 'B' })).json().card;
    t.clock.advance(1000);
    await c('DELETE', `/api/cards/${a.id}`);

    const list = await get(`/api/v1/cards?ids=${b.id},${a.id},987654`);
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(Object.keys(body).sort()).toEqual(['cards', 'generatedAt', 'more', 'next']);
    expect(body.cards.map((x: { id: number }) => x.id)).toEqual([a.id, b.id]);
    expect(body.cards[0].deletedAt).toEqual(expect.any(String));
    expect(body).toMatchObject({ more: false, next: null });

    const since = (q: string) => get(`/api/v1/cards?updatedSince=${encodeURIComponent(q)}`);
    expect((await since('2026-10-10T15:00:01Z')).json().cards.map((x: { title: string }) => x.title)).toEqual(['B', 'A']);
    // Offsets are normalized to UTC.
    expect((await since('2026-10-10T10:00:01-05:00')).json().cards).toHaveLength(2);
    expect((await since('2026-10-10T15:00:02.001Z')).json().cards).toEqual([]);
    expect((await get(`/api/v1/cards?ids=${b.id}&updatedSince=2026-10-10T15:00:02Z`)).json().cards).toEqual([]);

    for (const url of [
      '/api/v1/cards',
      '/api/v1/cards?ids=x',
      '/api/v1/cards?ids=',
      '/api/v1/cards?ids=,',
      `/api/v1/cards?ids=${Array.from({ length: 101 }, (_, i) => i + 1).join(',')}`,
      '/api/v1/cards?updatedSince=yesterday',
      '/api/v1/cards?updatedSince=2026-10-10T15:00:00', // no zone
      '/api/v1/cards?cursor=nope',
      `/api/v1/cards?cursor=${T0}_1&updatedSince=${T0}`,
    ]) {
      const bad = await get(url);
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toMatchObject({ error: 'validation', message: expect.any(String), errors: expect.any(Array) });
    }
  });

  it('reading tickets: pages of 200 with a next cursor, even when they all share one updatedAt', async () => {
    const { v1, get } = await setup();
    const total = API_TICKETS_PAGE * 2 + 5;
    for (let i = 0; i < total; i++) {
      if (i % 100 === 99) t.clock.advance(V1_LIMIT.windowMs); // stay under the rate limit
      await v1('/api/v1/cards', { title: `T${i}` });
    }
    // Bulk actions (deleting a tag, archiving all done) give many tickets the same updatedAt.
    t.ctx.db.prepare('UPDATE cards SET updated_at = ?').run(T0);

    const seen: number[] = [];
    let page = (await get(`/api/v1/cards?updatedSince=${T0}`)).json();
    for (let n = 0; ; n++) {
      expect(n).toBeLessThan(5);
      seen.push(...page.cards.map((x: { id: number }) => x.id));
      expect(page.more).toBe(page.next !== null);
      if (!page.more) break;
      expect(page.cards).toHaveLength(API_TICKETS_PAGE);
      page = (await get(`/api/v1/cards?cursor=${encodeURIComponent(page.next)}`)).json();
    }
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });

  it('reading tickets is closed to read-only tokens', async () => {
    const { c, v1, get } = await setup();
    const { id } = (await v1('/api/v1/cards', { title: 'x' })).json().card;
    const read = (await c('POST', '/api/tokens', { name: 'Homepage', scope: 'read' })).json().token;
    for (const url of [`/api/v1/cards/${id}`, `/api/v1/cards?ids=${id}`]) {
      const res = await get(url, `Bearer ${read}`);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'forbidden' });
      expect((await get(url, '')).statusCode).toBe(401);
    }
  });

  it('unknown /api/v1 paths need a token and answer a JSON 404, never a cookie or CSRF error', async () => {
    const { get, token } = await setup();
    expect((await get('/api/v1/nothing-here', '')).json()).toMatchObject({ error: 'unauthenticated' });
    const missing = await get('/api/v1/nothing-here');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: 'not_found' });
    const wrongMethod = await t.app.inject({ method: 'PUT', url: '/api/v1/summary', headers: { authorization: `Bearer ${token}` } });
    expect(wrongMethod.statusCode).toBe(404);
    expect(wrongMethod.json()).toMatchObject({ error: 'not_found' });
  });

  it('health needs no token', async () => {
    await setup();
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

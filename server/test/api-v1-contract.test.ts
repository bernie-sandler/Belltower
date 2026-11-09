// The /api/v1 contract (docs/API-V1.md) is frozen for 1.x. These tests pin the documented shapes:
// if one fails, the change breaks scripts and monitors in the field. Add to the API instead.

import { afterEach, describe, expect, it } from 'vitest';
import { V1_LIMIT } from '../src/http/routes/v1';
import { client, makeApp, setupAndLogin, type TestApp } from './helpers';

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

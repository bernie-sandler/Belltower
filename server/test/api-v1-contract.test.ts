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
  const { token } = (await c('POST', '/api/tokens', { name: 'Contract', canComplete })).json();
  const v1 = (url: string, body: unknown, auth = `Bearer ${token}`) =>
    t.app.inject({ method: 'POST', url, payload: body as object, headers: auth ? { authorization: auth } : {} });
  return { c, v1 };
}

const CARD_KEYS = ['columnId', 'completedAt', 'id', 'ticketNo', 'title'];

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

  it('health needs no token', async () => {
    await setup();
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

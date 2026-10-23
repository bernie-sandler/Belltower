import type { BoardResponse, CardDetail, MoveCardResponse } from '@tt/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { client, makeApp, setupAndLogin, type TestApp } from './helpers';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.shutdown();
  t = undefined;
});

describe('CSRF protection', () => {
  it('rejects mutations without the custom header or from another origin', async () => {
    t = await makeApp();
    const cookie = await setupAndLogin(t);

    const noHeader = await t.app.inject({ method: 'POST', url: '/api/cards', headers: { cookie }, payload: { title: 'x' } });
    expect(noHeader.statusCode).toBe(403);
    expect(noHeader.json().error).toBe('csrf');

    const crossSite = await client(t.app, cookie)('POST', '/api/cards', { title: 'x' }, {
      origin: 'http://evil.example',
      host: 'tower:8080',
    });
    expect(crossSite.statusCode).toBe(403);

    const sameOrigin = await client(t.app, cookie)('POST', '/api/cards', { title: 'x' }, {
      origin: 'http://tower:8080',
      host: 'tower:8080',
    });
    expect(sameOrigin.statusCode).toBe(201);

    // A sibling app on another port of the same host is a different origin.
    const otherPort = await client(t.app, cookie)('POST', '/api/cards', { title: 'x' }, {
      origin: 'http://tower:32400',
      host: 'tower:8080',
    });
    expect(otherPort.statusCode).toBe(403);
  });

  it('applies to login too', async () => {
    t = await makeApp();
    await setupAndLogin(t);
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'x' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('headers, health and static files', () => {
  it('sends a strict CSP without HTTPS upgrades or HSTS', async () => {
    t = await makeApp({ webDist: true });
    const res = await t.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('upgrade-insecure-requests');
    expect(res.headers['strict-transport-security']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('serves the SPA for client routes and caches hashed assets forever', async () => {
    t = await makeApp({ webDist: true });
    const deep = await t.app.inject({ method: 'GET', url: '/cards/42' });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain('Tower Tracker');
    const asset = await t.app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await t.app.inject({ method: 'GET', url: '/assets/missing.js' })).statusCode).toBe(404);
  });

  it('returns JSON 404s (not the SPA) for unknown API routes', async () => {
    t = await makeApp({ webDist: true });
    const cookie = await setupAndLogin(t);
    const res = await client(t.app, cookie)('GET', '/api/nope');
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('exposes an unauthenticated /health', async () => {
    t = await makeApp();
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('board API end to end', () => {
  it('creates, edits, moves and trashes a card through HTTP', async () => {
    t = await makeApp();
    const api = client(t.app, await setupAndLogin(t));

    const board = (await api('GET', '/api/board')).json() as BoardResponse;
    expect(board.columns).toHaveLength(5);
    expect(board.labels).toHaveLength(8);
    const [triage, backlog] = board.columns;

    const created = await api('POST', '/api/cards', { title: '  NPM cert renewal failing  ' });
    expect(created.statusCode).toBe(201);
    const card = created.json() as CardDetail;
    expect(card).toMatchObject({ title: 'NPM cert renewal failing', columnId: triage!.id, version: 1 });

    const patched = await api('PATCH', `/api/cards/${card.id}`, {
      expectedVersion: 1,
      description: 'Port 80 blocked?',
      labelIds: [board.labels[3]!.id],
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().version).toBe(2);

    const stale = await api('PATCH', `/api/cards/${card.id}`, { expectedVersion: 1, title: 'x' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'version_conflict', card: { version: 2 } });

    const moved = await api('POST', `/api/cards/${card.id}/move`, { toColumnId: backlog!.id, afterCardId: null });
    expect(moved.statusCode).toBe(200);
    expect((moved.json() as MoveCardResponse).orders).toEqual({ [triage!.id]: [], [backlog!.id]: [card.id] });

    const badAnchor = await api('POST', `/api/cards/${card.id}/move`, { toColumnId: backlog!.id, afterCardId: 9999 });
    expect(badAnchor.json().error).toBe('anchor_not_found');

    expect((await api('DELETE', `/api/cards/${card.id}`)).statusCode).toBe(204);
    expect(((await api('GET', '/api/board')).json() as BoardResponse).cards).toHaveLength(0);

    const activity = (await api('GET', `/api/cards/${card.id}/activity`)).json() as { type: string }[];
    expect(activity.map((a) => a.type)).toEqual(['deleted', 'moved', 'labels_changed', 'description_changed', 'created']);
  });

  it('validates input with clear messages', async () => {
    t = await makeApp();
    const api = client(t.app, await setupAndLogin(t));
    const res = await api('POST', '/api/cards', { title: '' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'validation' });
    expect((await api('GET', '/api/cards/abc')).statusCode).toBe(404);
    expect((await api('GET', '/api/cards/999')).statusCode).toBe(404);
    const col = await api('DELETE', `/api/columns/${(await api('GET', '/api/board')).json().columns[0].id}`);
    expect(col.json().error).toBe('role_column');
  });
});

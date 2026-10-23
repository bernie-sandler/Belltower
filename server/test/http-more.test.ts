import type { BoardResponse, CardDetail } from '@tt/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { client, makeApp, setupAndLogin, type TestApp } from './helpers';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.shutdown();
  t = undefined;
});

describe('guard and parsing edge cases', () => {
  it('requires auth and CSRF however the /api path is spelled', async () => {
    t = await makeApp({ webDist: true });
    await setupAndLogin(t);
    for (const url of ['/%61pi/board', '/ap%69/board', '/api/%62oard']) {
      const res = await t.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
      expect(res.headers['cache-control'], url).toBe('no-store');
    }
    const noCsrf = await t.app.inject({ method: 'POST', url: '/%61pi/cards', payload: { title: 'x' } });
    expect(noCsrf.statusCode).toBe(403);
    expect((await client(t.app)('POST', '/%61pi/cards', { title: 'x' })).statusCode).toBe(401);
    const pw = await client(t.app)('POST', '/%61pi/auth/password', {
      currentPassword: 'a',
      newPassword: 'b'.repeat(12),
    });
    expect(pw.statusCode).toBe(401);
  });

  it('accepts bodyless requests that still send a JSON content type', async () => {
    t = await makeApp();
    const api = client(t.app, await setupAndLogin(t));
    const card = (await api('POST', '/api/cards', { title: 'A' })).json() as CardDetail;
    const json = { 'content-type': 'application/json' };
    expect((await api('DELETE', `/api/cards/${card.id}`, undefined, json)).statusCode).toBe(204);
    expect((await api('POST', `/api/cards/${card.id}/undelete`, undefined, json)).statusCode).toBe(200);
    expect((await api('POST', '/api/auth/logout', undefined, json)).statusCode).toBe(204);
  });

  it('treats a stale column reference as invalid_target and a self-anchored move as a no-op', async () => {
    t = await makeApp();
    const api = client(t.app, await setupAndLogin(t));
    const a = (await api('POST', '/api/cards', { title: 'A' })).json() as CardDetail;
    const b = (await api('POST', '/api/cards', { title: 'B' })).json() as CardDetail;
    const stale = await api('POST', `/api/cards/${a.id}/move`, { toColumnId: 9999, afterCardId: null });
    expect(stale.statusCode).toBe(400);
    expect(stale.json().error).toBe('invalid_target');
    expect((await api('POST', '/api/cards', { title: 'X', columnId: 9999 })).json().error).toBe('invalid_target');
    const same = await api('POST', `/api/cards/${b.id}/move`, { toColumnId: b.columnId, afterCardId: b.id });
    expect(same.statusCode).toBe(200);
    expect(same.json().orders).toEqual({ [b.columnId]: [a.id, b.id] });
  });

  it('rejects NUL characters as validation errors, not 500s', async () => {
    t = await makeApp();
    const api = client(t.app, await setupAndLogin(t));
    expect((await api('POST', '/api/cards', { title: '\u0000abc' })).json().error).toBe('validation');
    expect((await api('POST', '/api/columns', { name: '\u0000' })).json().error).toBe('validation');
    expect((await api('POST', '/api/labels', { name: 'x\u0000', color: '#579dff' })).json().error).toBe('validation');
  });
});

describe('columns, labels, trash and archive over HTTP', () => {
  it('manages columns end to end', async () => {
    t = await makeApp();
    const api = client(t.app, await setupAndLogin(t));
    const col = (await api('POST', '/api/columns', { name: '  Parking lot ' })).json();
    expect(col).toMatchObject({ name: 'Parking lot', role: null, position: 5 });
    expect((await api('PATCH', `/api/columns/${col.id}`, { name: 'Someday' })).json().name).toBe('Someday');
    const ids = ((await api('GET', '/api/board')).json() as BoardResponse).columns.map((c) => c.id);
    const reordered = (
      await api('PUT', '/api/columns/order', { ids: [col.id, ...ids.filter((i) => i !== col.id)] })
    ).json() as { id: number; name: string; role: string | null }[];
    expect(reordered[0]!.name).toBe('Someday');

    const card = (await api('POST', '/api/cards', { title: 'A', columnId: col.id })).json() as CardDetail;
    expect((await api('DELETE', `/api/columns/${col.id}`)).json().error).toBe('target_required');
    const done = reordered.find((c) => c.role === 'done')!.id;
    expect((await api('DELETE', `/api/columns/${col.id}?targetColumnId=${done}`)).statusCode).toBe(204);
    const moved = (await api('GET', `/api/cards/${card.id}`)).json() as CardDetail;
    expect(moved.columnId).toBe(done);
    expect(moved.completedAt).not.toBeNull();
  });

  it('manages labels end to end', async () => {
    t = await makeApp();
    const api = client(t.app, await setupAndLogin(t));
    const label = (await api('POST', '/api/labels', { name: ' Grafana ', color: '#9f8fef' })).json();
    expect(label).toMatchObject({ name: 'Grafana', position: 8 });
    expect((await api('POST', '/api/labels', { name: 'grafana', color: '#9f8fef' })).statusCode).toBe(409);
    expect((await api('POST', '/api/labels', { name: 'Bad', color: '#ABCDEF' })).statusCode).toBe(400);
    expect((await api('PATCH', `/api/labels/${label.id}`, { color: '#4bce97' })).json().color).toBe('#4bce97');
    const ids = ((await api('GET', '/api/board')).json() as BoardResponse).labels.map((l) => l.id);
    expect((await api('PUT', '/api/labels/order', { ids: [...ids].reverse() })).json()[0].id).toBe(label.id);
    expect((await api('DELETE', `/api/labels/${label.id}`)).statusCode).toBe(204);
    expect(((await api('GET', '/api/board')).json() as BoardResponse).labels).toHaveLength(8);
  });

  it('trashes, restores, archives and un-archives with the documented errors', async () => {
    t = await makeApp();
    const api = client(t.app, await setupAndLogin(t));
    const board = (await api('GET', '/api/board')).json() as BoardResponse;
    const done = board.columns.find((c) => c.role === 'done')!.id;
    const card = (await api('POST', '/api/cards', { title: 'A' })).json() as CardDetail;
    expect((await api('POST', `/api/cards/${card.id}/archive`)).json().error).toBe('not_done');
    await api('DELETE', `/api/cards/${card.id}`);
    expect((await api('PATCH', `/api/cards/${card.id}`, { expectedVersion: 1, title: 'B' })).json().error).toBe(
      'card_deleted',
    );
    expect(
      (await api('POST', `/api/cards/${card.id}/move`, { toColumnId: done, afterCardId: null })).json().error,
    ).toBe('card_deleted');
    expect((await api('POST', `/api/cards/${card.id}/undelete`)).json().deletedAt).toBeNull();
    await api('POST', `/api/cards/${card.id}/move`, { toColumnId: done, afterCardId: null });
    expect((await api('POST', `/api/cards/${card.id}/archive`)).json().archivedAt).not.toBeNull();
    expect(
      (await api('POST', `/api/cards/${card.id}/move`, { toColumnId: done, afterCardId: null })).json().error,
    ).toBe('card_archived');
    expect((await api('POST', `/api/cards/${card.id}/restore`)).json().archivedAt).toBeNull();
    expect(((await api('GET', '/api/board')).json() as BoardResponse).cards.map((c) => c.id)).toEqual([card.id]);
  });
});

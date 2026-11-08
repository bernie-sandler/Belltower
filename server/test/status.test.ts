import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSetting } from '../src/db/connection';
import { STATUS_LIMIT } from '../src/http/routes/submit';
import { completeCard, createCard, deleteCard, moveCard } from '../src/services/cards';
import { createLink } from '../src/services/links';
import { listRequestTypes } from '../src/services/requestTypes';
import { getSubmitSettings, updateSubmitSettings } from '../src/services/settings';
import { publicStatus, resetStatusLinks, STATUS_SECRET_KEY, statusLink } from '../src/services/status';
import { submitTicket } from '../src/services/submit';
import { addWorklog } from '../src/services/worklog';
import { client, columnId, makeApp, makeCtx, setupAndLogin, type TestApp } from './helpers';

const PAGE_GONE = { error: 'not_found', message: 'This page doesn’t exist' };

/** "/submit/status/12/abc…" → ["12", "abc…"] */
const parts = (path: string) => {
  const m = /^\/submit\/status\/(\d+)\/([\w-]{22})$/.exec(path);
  if (!m) throw new Error(`unexpected status path ${path}`);
  return [m[1]!, m[2]!] as const;
};

describe('status links', () => {
  let t: ReturnType<typeof makeCtx>;
  beforeEach(() => {
    t = makeCtx();
    updateSubmitSettings(t.ctx, { enabled: true, columnId: null, pageTitle: 'Help', intro: '' });
  });
  afterEach(() => t.close());

  const statusOf = (id: number) => publicStatus(t.ctx, ...parts(statusLink(t.ctx, id).path));
  const expectGone = (fn: () => unknown) => expect(fn).toThrow('This page doesn’t exist');

  it('gives each ticket a stable link, active while the submit page is on', () => {
    const a = createCard(t.ctx, { title: 'Plex buffering' });
    const b = createCard(t.ctx, { title: 'NAS fan' });
    const link = statusLink(t.ctx, a.id);
    expect(link).toEqual({ path: expect.stringMatching(`^/submit/status/${a.id}/[\\w-]{22}$`), active: true });
    expect(statusLink(t.ctx, a.id).path).toBe(link.path);
    expect(statusLink(t.ctx, b.id).path).not.toBe(link.path);

    updateSubmitSettings(t.ctx, { enabled: false, columnId: null, pageTitle: 'Help', intro: '' });
    expect(statusLink(t.ctx, a.id)).toEqual({ path: link.path, active: false });
  });

  it('has no links for work cards, cards in the Trash or unknown cards', () => {
    const work = createCard(t.ctx, { title: 'Rebuild the rack', kind: 'work' });
    const trashed = createCard(t.ctx, { title: 'Old' });
    deleteCard(t.ctx, trashed.id);
    expect(() => statusLink(t.ctx, work.id)).toThrow('Only tickets have status links');
    expect(() => statusLink(t.ctx, trashed.id)).toThrow('This card is in the Trash');
    expect(() => statusLink(t.ctx, 9999)).toThrow('Card not found');
  });

  it('shows only the title, number, dates, state and resolution reason', () => {
    const card = createCard(t.ctx, { title: 'Plex buffering', description: 'private details', priority: 'high' });
    const s = statusOf(card.id);
    expect(s).toEqual({
      ticketNo: card.ticketNo,
      title: 'Plex buffering',
      submittedAt: card.createdAt,
      state: 'received',
      resolution: null,
      changedAt: card.createdAt,
    });
  });

  it('works out the state: received, in progress, waiting, done', () => {
    const card = createCard(t.ctx, { title: 'Plex buffering' });
    expect(statusOf(card.id).state).toBe('received');

    moveCard(t.ctx, card.id, { toColumnId: columnId(t.ctx, 'In Progress'), afterCardId: null });
    expect(statusOf(card.id).state).toBe('in_progress');

    moveCard(t.ctx, card.id, { toColumnId: columnId(t.ctx, 'Blocked/Waiting'), afterCardId: null });
    expect(statusOf(card.id).state).toBe('waiting');

    // Blocked by an open card counts as waiting wherever it sits.
    moveCard(t.ctx, card.id, { toColumnId: columnId(t.ctx, 'In Progress'), afterCardId: null });
    const blocker = createCard(t.ctx, { title: 'Replace the disk' });
    createLink(t.ctx, card.id, blocker.id, 'blocked_by');
    expect(statusOf(card.id).state).toBe('waiting');
    completeCard(t.ctx, blocker.id, { includeChildren: false });

    completeCard(t.ctx, card.id, { includeChildren: false, resolution: { reason: 'Fixed', note: 'Swapped the cable in the closet' } });
    const done = statusOf(card.id);
    expect(done).toMatchObject({ state: 'done', resolution: 'Fixed' });
    expect(JSON.stringify(done)).not.toContain('closet');
  });

  it('counts the submit page’s own column as received', () => {
    updateSubmitSettings(t.ctx, { enabled: true, columnId: columnId(t.ctx, 'Backlog'), pageTitle: 'Help', intro: '' });
    const card = createCard(t.ctx, { title: 'From the page', columnId: columnId(t.ctx, 'Backlog') });
    expect(statusOf(card.id).state).toBe('received');
  });

  it('dates the last move or completion, not private notes', () => {
    const card = createCard(t.ctx, { title: 'Plex buffering' });
    t.clock.advance(60_000);
    moveCard(t.ctx, card.id, { toColumnId: columnId(t.ctx, 'In Progress'), afterCardId: null });
    const movedAt = t.clock.now().toISOString();
    t.clock.advance(60_000);
    addWorklog(t.ctx, card.id, { bodyMd: 'Private note' });
    expect(statusOf(card.id).changedAt).toBe(movedAt);
  });

  it('rejects wrong, malformed and tampered links the same way', () => {
    const a = createCard(t.ctx, { title: 'A' });
    const b = createCard(t.ctx, { title: 'B' });
    const [id, sig] = parts(statusLink(t.ctx, a.id).path);
    expect(publicStatus(t.ctx, id, sig).title).toBe('A');
    const flipped = `${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`;
    expectGone(() => publicStatus(t.ctx, id, flipped));
    expectGone(() => publicStatus(t.ctx, String(b.id), sig));
    for (const bad of ['0', '01', '-1', 'abc', '1e3', '9999999999999']) expectGone(() => publicStatus(t.ctx, bad, sig));
    for (const bad of ['', 'short', `${sig}x`, sig.replace(/./, '.')]) expectGone(() => publicStatus(t.ctx, id, bad));
    expectGone(() => publicStatus(t.ctx, '9999', sig));
  });

  it('stops answering when the card is trashed or the submit page is off', () => {
    const card = createCard(t.ctx, { title: 'A' });
    const link = parts(statusLink(t.ctx, card.id).path);
    updateSubmitSettings(t.ctx, { enabled: false, columnId: null, pageTitle: 'Help', intro: '' });
    expectGone(() => publicStatus(t.ctx, ...link));
    updateSubmitSettings(t.ctx, { enabled: true, columnId: null, pageTitle: 'Help', intro: '' });
    expect(publicStatus(t.ctx, ...link).title).toBe('A');
    deleteCard(t.ctx, card.id);
    expectGone(() => publicStatus(t.ctx, ...link));
  });

  it('never shows another ticket that got the same id (an older backup restored)', () => {
    const card = createCard(t.ctx, { title: 'Mine' });
    const link = parts(statusLink(t.ctx, card.id).path);
    // As if a restore dropped this card and a new one took its id later.
    t.ctx.db.prepare("UPDATE cards SET title = 'Someone else’s', created_at = ? WHERE id = ?").run('2026-10-11T09:00:00.000Z', card.id);
    expectGone(() => publicStatus(t.ctx, ...link));
  });

  it('reset cuts off every link handed out so far', () => {
    const card = createCard(t.ctx, { title: 'A' });
    const before = statusLink(t.ctx, card.id).path;
    resetStatusLinks(t.ctx);
    expectGone(() => publicStatus(t.ctx, ...parts(before)));
    const after = statusLink(t.ctx, card.id).path;
    expect(after).not.toBe(before);
    expect(publicStatus(t.ctx, ...parts(after)).title).toBe('A');
  });

  it('never creates the signing secret from the public side', () => {
    const card = createCard(t.ctx, { title: 'A' });
    expectGone(() => publicStatus(t.ctx, String(card.id), 'a'.repeat(22)));
    expect(getSetting(t.ctx.db, STATUS_SECRET_KEY)).toBeNull();
    statusLink(t.ctx, card.id);
    expect(getSetting(t.ctx.db, STATUS_SECRET_KEY)).toMatch(/^[\w-]{43}$/);
  });
});

describe('status links over HTTP', () => {
  let app: TestApp;
  afterEach(() => app?.shutdown());

  async function start() {
    app = await makeApp();
    const cookie = await setupAndLogin(app);
    updateSubmitSettings(app.ctx, { enabled: true, columnId: null, pageTitle: 'Help', intro: '' });
    return cookie;
  }

  it('answers signed out, with the same 404 for every failure', async () => {
    await start();
    const card = createCard(app.ctx, { title: 'Plex buffering' });
    const path = statusLink(app.ctx, card.id).path;
    const [id, sig] = parts(path);
    const get = (url: string) => app.app.inject({ method: 'GET', url });

    const ok = await get(`/api/public/status/${id}/${sig}`);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.json()).toMatchObject({ title: 'Plex buffering', state: 'received' });

    const gone = [await get(`/api/public/status/${id}/${'x'.repeat(22)}`), await get(`/api/public/status/abc/${sig}`)];
    updateSubmitSettings(app.ctx, { enabled: false, columnId: null, pageTitle: 'Help', intro: '' });
    gone.push(await get(`/api/public/status/${id}/${sig}`));
    for (const res of gone) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(PAGE_GONE);
    }
  });

  it('limits how often one address can check', async () => {
    await start();
    const card = createCard(app.ctx, { title: 'A' });
    const [id, sig] = parts(statusLink(app.ctx, card.id).path);
    for (let i = 0; i < STATUS_LIMIT.max; i++) {
      expect((await app.app.inject({ method: 'GET', url: `/api/public/status/${id}/${sig}` })).statusCode).toBe(200);
    }
    const limited = await app.app.inject({ method: 'GET', url: `/api/public/status/${id}/${sig}` });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });

  it('copying a link and resetting them need a session', async () => {
    const cookie = await start();
    const card = createCard(app.ctx, { title: 'A' });
    expect((await client(app.app)('GET', `/api/cards/${card.id}/status-link`)).statusCode).toBe(401);
    expect((await client(app.app)('POST', '/api/settings/submit/reset-status-links')).statusCode).toBe(401);

    const api = client(app.app, cookie);
    const first = await api('GET', `/api/cards/${card.id}/status-link`);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ path: expect.stringMatching(/^\/submit\/status\//), active: true });
    const reset = await api('POST', '/api/settings/submit/reset-status-links');
    expect(reset.statusCode).toBe(200);
    expect(JSON.stringify(reset.json())).not.toContain(getSetting(app.ctx.db, STATUS_SECRET_KEY)!);
    expect((await api('GET', `/api/cards/${card.id}/status-link`)).json().path).not.toBe(first.json().path);
  });

  it('the submit page hands out a working link', async () => {
    await start();
    // Filed through the service directly; the multipart route itself is covered in submit.test.ts.
    const key = getSubmitSettings(app.ctx).key!;
    const type = listRequestTypes(app.ctx)[0]!;
    const answers = Object.fromEntries(
      type.fields
        .filter((f) => f.required)
        .map((f) => [f.key, f.kind === 'choice' ? f.options[0]! : f.kind === 'multi' ? [f.options[0]!] : f.kind === 'yesno' ? true : f.kind === 'datetime' ? '2026-10-10T10:00' : 'x']),
    );
    const body = { typeId: type.id, summary: 'No sound', description: 'Silent', answers, tagLabelIds: [], name: '', website: '' };
    const result = submitTicket(app.ctx, key, body, [], app.dir);
    expect(result.statusPath).toMatch(/^\/submit\/status\/\d+\/[\w-]{22}$/);
    const res = await app.app.inject({ method: 'GET', url: `/api/public${result.statusPath!.replace('/submit', '')}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ticketNo: result.ticketNo, state: 'received' });
  });
});

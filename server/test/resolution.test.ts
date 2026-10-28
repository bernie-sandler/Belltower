import { ResolutionReasonsBody } from '@tt/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/errors';
import { listActivity } from '../src/services/activity';
import { completeCard, createCard, getCard, getCardTile, moveCard, updateCard } from '../src/services/cards';
import { importCards } from '../src/services/cardImport';
import { searchCards } from '../src/services/search';
import { getResolutionReasons, setResolutionReasons } from '../src/services/settings';
import { SearchQuery } from '@tt/shared';
import { client, columnId, makeApp, makeCtx, setupAndLogin, type TestApp } from './helpers';

let t: ReturnType<typeof makeCtx>;
beforeEach(() => {
  t = makeCtx();
});
afterEach(() => t.close());

function failure(fn: () => unknown): AppError {
  try {
    fn();
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error('expected an AppError');
}

const fixed = (note = '') => ({ reason: 'Fixed', note });

describe('resolutions', () => {
  it('are recorded when a card is marked done, logged, and searchable', () => {
    const card = createCard(t.ctx, { title: 'Plex stutters' });
    const res = completeCard(t.ctx, card.id, { includeChildren: false, resolution: fixed('Lowered transcoder quality to 1080p.') });
    expect(res.card).toMatchObject({ resolution: 'Fixed', resolutionNote: 'Lowered transcoder quality to 1080p.' });
    expect(getCardTile(t.ctx, card.id).resolution).toBe('Fixed');
    expect(listActivity(t.ctx, card.id).find((e) => e.type === 'resolved')!.data).toMatchObject({ reason: 'Fixed', from: null });
    const found = searchCards(t.ctx, SearchQuery.parse({ q: 'transcoder 1080p' }));
    expect(found.map((r) => r.id)).toEqual([card.id]);
  });

  it('can be added or changed after the card is done, but not before', () => {
    const card = createCard(t.ctx, { title: 'Router' });
    expect(failure(() => updateCard(t.ctx, card.id, { resolution: fixed() })).code).toBe('not_done');
    moveCard(t.ctx, card.id, { toColumnId: columnId(t.ctx, 'Done'), afterCardId: null }); // dragged: no resolution yet
    expect(getCard(t.ctx, card.id).resolution).toBeNull();
    expect(updateCard(t.ctx, card.id, { resolution: { reason: 'Won’t fix', note: 'Replacing it next year.' } })).toMatchObject({
      resolution: 'Won’t fix',
      resolutionNote: 'Replacing it next year.',
    });
    expect(updateCard(t.ctx, card.id, { resolution: null }).resolution).toBeNull();
  });

  it('are cleared when the card is reopened; the history keeps every one', () => {
    const card = createCard(t.ctx, { title: 'NAS' });
    completeCard(t.ctx, card.id, { includeChildren: false, resolution: fixed('Swapped the cable.') });
    moveCard(t.ctx, card.id, { toColumnId: columnId(t.ctx, 'In Progress'), afterCardId: null });
    expect(getCard(t.ctx, card.id)).toMatchObject({ resolution: null, resolutionNote: '' });
    completeCard(t.ctx, card.id, { includeChildren: false, resolution: fixed('Replaced the disk.') });
    const notes = listActivity(t.ctx, card.id)
      .filter((e) => e.type === 'resolved')
      .map((e) => e.data.note);
    expect(notes).toEqual(['Replaced the disk.', 'Swapped the cable.']);
  });

  it('apply to a work card’s tickets when completed together', () => {
    const w = createCard(t.ctx, { title: 'Upgrade', kind: 'work' });
    const a = createCard(t.ctx, { title: 'A', parentId: w.id });
    completeCard(t.ctx, w.id, { includeChildren: true, resolution: { reason: 'No longer needed', note: '' } });
    expect(getCard(t.ctx, a.id).resolution).toBe('No longer needed');
    expect(getCard(t.ctx, w.id).resolution).toBe('No longer needed');
  });

  it('have an editable list of reasons; the first is the default', () => {
    expect(getResolutionReasons(t.ctx)[0]).toBe('Fixed');
    setResolutionReasons(t.ctx, ['Solved', 'Ignored']);
    expect(getResolutionReasons(t.ctx)).toEqual(['Solved', 'Ignored']);
    expect(ResolutionReasonsBody.safeParse({ reasons: [] }).success).toBe(false);
    expect(ResolutionReasonsBody.safeParse({ reasons: ['A', 'a'] }).success).toBe(false);
    expect(ResolutionReasonsBody.safeParse({ reasons: ['x'.repeat(41)] }).success).toBe(false);
  });
});

describe('importing resolutions', () => {
  it('keeps them for cards created in Done, and warns otherwise', () => {
    const res = importCards(
      t.ctx,
      [
        { title: 'Old outage', column: 'Done', resolution: { reason: 'duplicate', note: 'Same as the router one.' } },
        { title: 'Still open', resolution: 'Fixed' },
        { title: 'Done plain', column: 'Done', resolution: 'Rebooted', resolutionNote: 'Twice.' },
      ],
      false,
    );
    expect(res.items[0]!.card!.resolution).toEqual({ reason: 'Duplicate', note: 'Same as the router one.' });
    expect(res.items[1]!.card!.resolution).toBeNull();
    expect(res.items[1]!.warnings.join()).toMatch(/only kept for cards in Done/);
    expect(res.items[2]!.warnings.join()).toMatch(/isn't in your list/);
    expect(getCard(t.ctx, res.created[0]!)).toMatchObject({ resolution: 'Duplicate', resolutionNote: 'Same as the router one.' });
    expect(getCard(t.ctx, res.created[2]!)).toMatchObject({ resolution: 'Rebooted', resolutionNote: 'Twice.' });
  });
});

describe('resolutions over HTTP', () => {
  let app: TestApp;
  afterEach(() => app?.shutdown());

  it('Mark done sends one, and automation recoveries record the default reason', async () => {
    app = await makeApp();
    const c = client(app.app, await setupAndLogin(app));
    const card = (await c('POST', '/api/cards', { title: 'Fans' })).json();
    const res = await c('POST', `/api/cards/${card.id}/complete`, { resolution: { reason: 'Fixed', note: 'Cleaned the filter.' } });
    expect(res.json().card).toMatchObject({ resolution: 'Fixed', resolutionNote: 'Cleaned the filter.' });

    const s = (await c('PUT', '/api/settings/resolutions', { reasons: ['Solved', 'Not a problem'] })).json();
    expect(s.resolutionReasons).toEqual(['Solved', 'Not a problem']);
    expect((await c('GET', '/api/board')).json().resolutionReasons).toEqual(['Solved', 'Not a problem']);

    const { token } = (await c('POST', '/api/tokens', { name: 'Kuma', canComplete: true })).json();
    const v1 = (body: unknown) => app.app.inject({ method: 'POST', url: '/api/v1/cards', payload: body as object, headers: { authorization: `Bearer ${token}` } });
    const opened = (await v1({ title: 'Down', dedupeKey: 'k' })).json();
    await v1({ dedupeKey: 'k', event: 'resolved' });
    expect(getCard(app.ctx, opened.card.id)).toMatchObject({ resolution: 'Solved', resolutionNote: 'Recovered (reported by API token “Kuma”).' });
  });
});

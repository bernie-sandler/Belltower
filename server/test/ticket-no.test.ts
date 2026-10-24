import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listActivity } from '../src/services/activity';
import { listCards } from '../src/services/cardParts';
import { assignTicketNumbers, createCard, deleteCard, getCard } from '../src/services/cards';
import { importCards } from '../src/services/cardImport';
import { searchCards } from '../src/services/search';
import { SearchQuery } from '@tt/shared';
import { makeCtx } from './helpers';

let t: ReturnType<typeof makeCtx>;
beforeEach(() => {
  t = makeCtx(); // 2026-10-10 10:00 in Chicago
});
afterEach(() => t.close());

describe('ticket numbers', () => {
  it('are YYMMDD-N with a counter that restarts each local day', () => {
    expect(createCard(t.ctx, { title: 'First' }).ticketNo).toBe('261010-1');
    expect(createCard(t.ctx, { title: 'Second' }).ticketNo).toBe('261010-2');

    // 23:30 Chicago on Oct 10 is already Oct 11 in UTC; the local date wins.
    t.clock.set('2026-10-11T04:30:00.000Z');
    expect(createCard(t.ctx, { title: 'Late' }).ticketNo).toBe('261010-3');

    t.clock.set('2026-10-11T15:00:00.000Z');
    expect(createCard(t.ctx, { title: 'Next day' }).ticketNo).toBe('261011-1');
  });

  it('are never reused, even when a card is in the Trash', () => {
    const a = createCard(t.ctx, { title: 'A' });
    deleteCard(t.ctx, a.id);
    expect(createCard(t.ctx, { title: 'B' }).ticketNo).toBe('261010-2');
  });

  it('count past 9 numerically', () => {
    for (let i = 0; i < 10; i++) createCard(t.ctx, { title: `Card ${i}` });
    expect(createCard(t.ctx, { title: 'Eleventh' }).ticketNo).toBe('261010-11');
  });

  it('are given to every way a card is created and recorded on the created event', () => {
    const r = importCards(t.ctx, JSON.stringify({ title: 'Imported' }), false);
    expect(getCard(t.ctx, r.created[0]!).ticketNo).toBe('261010-1');
    const card = createCard(t.ctx, { title: 'Manual' });
    expect(listActivity(t.ctx, card.id).find((e) => e.type === 'created')!.data).toMatchObject({ ticketNo: '261010-2' });
  });

  it('are assigned to existing cards by creation date, oldest first', () => {
    const a = createCard(t.ctx, { title: 'A' });
    const b = createCard(t.ctx, { title: 'B' });
    t.ctx.db.prepare('UPDATE cards SET ticket_no = NULL').run();
    t.ctx.db.prepare("UPDATE cards SET created_at = '2026-09-01T12:00:00.000Z' WHERE id = ?").run(b.id);
    expect(assignTicketNumbers(t.ctx)).toBe(2);
    expect(getCard(t.ctx, b.id).ticketNo).toBe('260901-1');
    expect(getCard(t.ctx, a.id).ticketNo).toBe('261010-1');
    expect(assignTicketNumbers(t.ctx)).toBe(0);
  });

  it('can be searched for, and found in the link picker', () => {
    createCard(t.ctx, { title: 'Plex' });
    const nginx = createCard(t.ctx, { title: 'Nginx 502' });
    const q = SearchQuery.parse({ q: '261010-2' });
    expect(searchCards(t.ctx, q).map((r) => r.ticketNo)).toEqual(['261010-2']);
    expect(listCards(t.ctx, { status: 'live', q: '261010-2', limit: 10 }).map((c) => c.id)).toEqual([nginx.id]);
  });
});

import type { CardDetail, MoveCardsResponse } from '@tt/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/errors';
import { listActivity } from '../src/services/activity';
import { archiveCard, createCard, deleteCard, getBoard, getCard, moveCard, moveCards } from '../src/services/cards';
import { createLink } from '../src/services/links';
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

/** Ids in a column, top to bottom. */
const idsIn = (name: string) =>
  getBoard(t.ctx)
    .cards.filter((c) => c.columnId === columnId(t.ctx, name))
    .sort((a, b) => a.position - b.position)
    .map((c) => c.id);

/** Three tickets in In Progress and one more card under them. */
function folder() {
  const inProgress = columnId(t.ctx, 'In Progress');
  const work = createCard(t.ctx, { title: 'Router swap', kind: 'work', columnId: columnId(t.ctx, 'Backlog') });
  const a = createCard(t.ctx, { title: 'Order router', parentId: work.id, columnId: inProgress });
  const b = createCard(t.ctx, { title: 'Flash firmware', parentId: work.id, columnId: inProgress });
  const c = createCard(t.ctx, { title: 'Swap cables', parentId: work.id, columnId: inProgress });
  const other = createCard(t.ctx, { title: 'Unrelated', columnId: inProgress });
  return { work, a, b, c, other };
}

/** The state a failed block move must leave untouched. */
function snapshot() {
  const board = getBoard(t.ctx);
  return {
    cards: board.cards.map((c) => [c.id, c.columnId, c.position, c.completedAt]),
    moved: board.cards.flatMap((c) => listActivity(t.ctx, c.id).filter((e) => e.type === 'moved')).length,
  };
}

describe('moveCards', () => {
  it('moves the cards in order, right after the anchor, and returns the final orders', () => {
    const { work, a, b, c, other } = folder();
    const backlog = columnId(t.ctx, 'Backlog');
    const inProgress = columnId(t.ctx, 'In Progress');
    const below = createCard(t.ctx, { title: 'Below the anchor', columnId: backlog });

    const res = moveCards(t.ctx, [a.id, b.id, c.id], { toColumnId: backlog, afterCardId: work.id });

    expect(idsIn('Backlog')).toEqual([work.id, a.id, b.id, c.id, below.id]);
    expect(idsIn('In Progress')).toEqual([other.id]);
    expect(res.orders).toEqual({ [backlog]: [work.id, a.id, b.id, c.id, below.id], [inProgress]: [other.id] });
    expect(res.cards.map((card) => [card.id, card.columnId])).toEqual([a, b, c].map((card) => [card.id, backlog]));
    for (const card of [a, b, c]) {
      expect(listActivity(t.ctx, card.id).filter((e) => e.type === 'moved')).toHaveLength(1);
    }
  });

  it('puts the cards at the top when there is no anchor', () => {
    const { a, b, c, other } = folder();
    const backlogCard = idsIn('Backlog')[0]!;
    moveCards(t.ctx, [a.id, b.id, c.id], { toColumnId: columnId(t.ctx, 'Backlog'), afterCardId: null });
    expect(idsIn('Backlog')).toEqual([a.id, b.id, c.id, backlogCard]);
    expect(idsIn('In Progress')).toEqual([other.id]);
  });

  it('completes the cards entering Done and reopens them on the way out', () => {
    const { a, b } = folder();
    const done = columnId(t.ctx, 'Done');
    const backlog = columnId(t.ctx, 'Backlog');
    const res = moveCards(t.ctx, [a.id, b.id], { toColumnId: done, afterCardId: null });
    expect(res.cards.every((c) => c.completedAt !== null)).toBe(true);
    expect(idsIn('Done')).toEqual([a.id, b.id]);

    const back = moveCards(t.ctx, [a.id, b.id], { toColumnId: backlog, afterCardId: null });
    expect(back.cards.every((c) => c.completedAt === null)).toBe(true);
  });

  it('moves nothing when a later card is in the Trash', () => {
    const { a, b, c } = folder();
    deleteCard(t.ctx, c.id);
    const before = snapshot();

    const err = failure(() => moveCards(t.ctx, [a.id, b.id, c.id], { toColumnId: columnId(t.ctx, 'Backlog'), afterCardId: null }));

    expect(err.status).toBe(409);
    expect(err.code).toBe('card_deleted');
    expect(err.message).toContain('Swap cables');
    expect(snapshot()).toEqual(before);
  });

  it('moves nothing when a later card was archived', () => {
    const { a, b } = folder();
    const done = createCard(t.ctx, { title: 'Already finished', columnId: columnId(t.ctx, 'Done') });
    archiveCard(t.ctx, done.id);
    const before = snapshot();

    const err = failure(() => moveCards(t.ctx, [a.id, b.id, done.id], { toColumnId: columnId(t.ctx, 'Backlog'), afterCardId: null }));

    expect(err.code).toBe('card_archived');
    expect(err.message).toContain('Already finished');
    expect(snapshot()).toEqual(before);
  });

  it('moves nothing when a later card no longer exists', () => {
    const { a, b } = folder();
    const before = snapshot();
    const err = failure(() => moveCards(t.ctx, [a.id, b.id, 99999], { toColumnId: columnId(t.ctx, 'Backlog'), afterCardId: null }));
    expect(err.status).toBe(404);
    expect(snapshot()).toEqual(before);
  });

  it('moves nothing into Done when any card is blocked by an open card', () => {
    const { a, b, c } = folder();
    const blocker = createCard(t.ctx, { title: 'Order part' });
    createLink(t.ctx, c.id, blocker.id, 'blocked_by');
    const before = snapshot();

    const err = failure(() => moveCards(t.ctx, [a.id, b.id, c.id], { toColumnId: columnId(t.ctx, 'Done'), afterCardId: null }));

    expect(err.code).toBe('blocked');
    expect(err.extra.blockers).toEqual([{ id: blocker.id, title: 'Order part' }]);
    expect(snapshot()).toEqual(before);
  });

  it("gives the same answer whichever order the cards come in when one blocks another", () => {
    const { a, b } = folder();
    createLink(t.ctx, b.id, a.id, 'blocked_by');
    moveCard(t.ctx, b.id, { toColumnId: columnId(t.ctx, 'In Progress'), afterCardId: a.id }); // parked by the link; back beside it
    const done = columnId(t.ctx, 'Done');
    expect(failure(() => moveCards(t.ctx, [a.id, b.id], { toColumnId: done, afterCardId: null })).code).toBe('blocked');
    expect(failure(() => moveCards(t.ctx, [b.id, a.id], { toColumnId: done, afterCardId: null })).code).toBe('blocked');
    expect(getCard(t.ctx, a.id).completedAt).toBeNull();
  });

  it('moves nothing when the anchor or the column is gone', () => {
    const { a, b } = folder();
    const inTriage = createCard(t.ctx, { title: 'In another column', columnId: columnId(t.ctx, 'Triage') });
    const before = snapshot();
    const backlog = columnId(t.ctx, 'Backlog');
    expect(failure(() => moveCards(t.ctx, [a.id, b.id], { toColumnId: backlog, afterCardId: inTriage.id })).code).toBe('anchor_not_found');
    expect(failure(() => moveCards(t.ctx, [a.id, b.id], { toColumnId: 9999, afterCardId: null })).code).toBe('invalid_target');
    expect(snapshot()).toEqual(before);
  });

  it('rolls back the cards already moved when one fails partway through', () => {
    const { a, b, c } = folder();
    const before = snapshot();
    // Every check passes up front; then the database refuses the second card, after the first moved.
    t.ctx.db.exec(
      `CREATE TEMP TRIGGER fail_partway BEFORE UPDATE OF column_id ON cards WHEN NEW.id = ${b.id}
       BEGIN SELECT RAISE(ABORT, 'disk full'); END`,
    );

    expect(() => moveCards(t.ctx, [a.id, b.id, c.id], { toColumnId: columnId(t.ctx, 'Backlog'), afterCardId: null })).toThrow('disk full');

    expect(snapshot()).toEqual(before);
  });
});

describe('POST /api/cards/move-many', () => {
  let app: TestApp | undefined;
  afterEach(async () => {
    await app?.shutdown();
    app = undefined;
  });

  it('moves the cards, and validates the body', async () => {
    app = await makeApp();
    const api = client(app.app, await setupAndLogin(app));
    const a = (await api('POST', '/api/cards', { title: 'A' })).json() as CardDetail;
    const b = (await api('POST', '/api/cards', { title: 'B' })).json() as CardDetail;
    const toColumnId = columnId(app.ctx, 'Backlog');

    const ok = await api('POST', '/api/cards/move-many', { cardIds: [a.id, b.id], toColumnId, afterCardId: null });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as MoveCardsResponse;
    expect(body.cards.map((c) => c.columnId)).toEqual([toColumnId, toColumnId]);
    expect(body.orders[toColumnId]).toEqual([a.id, b.id]);

    for (const bad of [
      { cardIds: [], toColumnId, afterCardId: null },
      { cardIds: [a.id, a.id], toColumnId, afterCardId: null },
      { cardIds: [a.id, b.id], toColumnId, afterCardId: b.id },
      { cardIds: [a.id], toColumnId },
    ]) {
      const res = await api('POST', '/api/cards/move-many', bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json().error).toBe('validation');
    }
  });

  it('answers a failed move with the code and a message naming the card', async () => {
    app = await makeApp();
    const api = client(app.app, await setupAndLogin(app));
    const a = (await api('POST', '/api/cards', { title: 'A' })).json() as CardDetail;
    const b = (await api('POST', '/api/cards', { title: 'Trashed' })).json() as CardDetail;
    await api('DELETE', `/api/cards/${b.id}`);

    const res = await api('POST', '/api/cards/move-many', {
      cardIds: [a.id, b.id],
      toColumnId: columnId(app.ctx, 'Backlog'),
      afterCardId: null,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('card_deleted');
    expect(res.json().message).toContain('Trashed');
    expect(((await api('GET', `/api/cards/${a.id}`)).json() as CardDetail).columnId).toBe(a.columnId);
  });

  it('needs a session like the rest of /api', async () => {
    app = await makeApp();
    await setupAndLogin(app);
    const res = await client(app.app)('POST', '/api/cards/move-many', { cardIds: [1], toColumnId: 1, afterCardId: null });
    expect(res.statusCode).toBe(401);
  });
});

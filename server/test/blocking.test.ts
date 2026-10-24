import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/errors';
import { listActivity } from '../src/services/activity';
import { archiveCard, createCard, deleteCard, getCard, getCardTile, moveCard, undeleteCard } from '../src/services/cards';
import { createColumn, deleteColumn, getBlockedColumnId, setBlockedColumn } from '../src/services/columns';
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

const toDone = (id: number) => moveCard(t.ctx, id, { toColumnId: columnId(t.ctx, 'Done'), afterCardId: null });

/** `blocked` is blocked by `blocker`. */
function pair() {
  const blocked = createCard(t.ctx, { title: 'Upgrade Plex' });
  const blocker = createCard(t.ctx, { title: 'Back up Plex database' });
  createLink(t.ctx, blocked.id, blocker.id, 'blocked_by');
  return { blocked, blocker };
}

describe('blocked cards', () => {
  it("can't be completed while a blocker is open, and can once it's done", () => {
    const { blocked, blocker } = pair();
    expect(getCardTile(t.ctx, blocked.id).blockedBy).toBe(1);

    const err = failure(() => toDone(blocked.id));
    expect(err.status).toBe(409);
    expect(err.code).toBe('blocked');
    expect(err.message).toContain('Back up Plex database');
    expect(err.extra.blockers).toEqual([{ id: blocker.id, title: 'Back up Plex database' }]);
    expect(getCard(t.ctx, blocked.id).completedAt).toBeNull();

    toDone(blocker.id);
    expect(getCardTile(t.ctx, blocked.id).blockedBy).toBe(0);
    expect(toDone(blocked.id).card.completedAt).not.toBeNull();
  });

  it('can still move between other columns while blocked', () => {
    const { blocked } = pair();
    const moved = moveCard(t.ctx, blocked.id, { toColumnId: columnId(t.ctx, 'In Progress'), afterCardId: null });
    expect(moved.card.columnId).toBe(columnId(t.ctx, 'In Progress'));
  });

  it('needs every blocker done; archived blockers count as done, trashed ones are ignored', () => {
    const blocked = createCard(t.ctx, { title: 'Replace array disk' });
    const b1 = createCard(t.ctx, { title: 'Order disk' });
    const b2 = createCard(t.ctx, { title: 'Preclear disk' });
    const b3 = createCard(t.ctx, { title: 'Obsolete idea' });
    for (const b of [b1, b2, b3]) createLink(t.ctx, b.id, blocked.id, 'blocks');
    expect(getCardTile(t.ctx, blocked.id).blockedBy).toBe(3);

    // b3 also blocks a card that isn't done yet, to check restoring it from the Trash later.
    const other = createCard(t.ctx, { title: 'Another' });
    createLink(t.ctx, b3.id, other.id, 'blocks');

    toDone(b1.id);
    archiveCard(t.ctx, b1.id);
    deleteCard(t.ctx, b3.id);
    expect(getCardTile(t.ctx, blocked.id).blockedBy).toBe(1);
    expect(failure(() => toDone(blocked.id)).code).toBe('blocked');

    toDone(b2.id);
    expect(toDone(blocked.id).card.completedAt).not.toBeNull();

    // Restoring a trashed blocker counts again for cards that aren't done yet.
    expect(getCardTile(t.ctx, other.id).blockedBy).toBe(0);
    undeleteCard(t.ctx, b3.id);
    expect(getCardTile(t.ctx, other.id).blockedBy).toBe(1);
  });

  it('"related" links never block', () => {
    const a = createCard(t.ctx, { title: 'A' });
    const b = createCard(t.ctx, { title: 'B' });
    createLink(t.ctx, a.id, b.id, 'relates');
    expect(getCardTile(t.ctx, a.id).blockedBy).toBe(0);
    expect(toDone(a.id).card.completedAt).not.toBeNull();
  });

  it("an open card can't be added as a blocker of a completed one", () => {
    const done = createCard(t.ctx, { title: 'Finished', columnId: columnId(t.ctx, 'Done') });
    const open = createCard(t.ctx, { title: 'Open' });
    expect(failure(() => createLink(t.ctx, done.id, open.id, 'blocked_by')).code).toBe('blocked');
    expect(failure(() => createLink(t.ctx, open.id, done.id, 'blocks')).code).toBe('blocked');
    // The other way round (a done card blocking an open one) is fine.
    expect(createLink(t.ctx, open.id, done.id, 'blocked_by').links).toHaveLength(1);
  });

  it('refuses to delete a column into Done while one of its cards is blocked', () => {
    setBlockedColumn(t.ctx, null); // keep the blocked card in its own column
    const col = createColumn(t.ctx, 'Parked');
    const blocked = createCard(t.ctx, { title: 'Parked work', columnId: col.id });
    const blocker = createCard(t.ctx, { title: 'Prerequisite' });
    createLink(t.ctx, blocked.id, blocker.id, 'blocked_by');

    expect(failure(() => deleteColumn(t.ctx, col.id, columnId(t.ctx, 'Done'))).code).toBe('blocked');
    expect(getCard(t.ctx, blocked.id).columnId).toBe(col.id); // nothing moved

    deleteColumn(t.ctx, col.id, columnId(t.ctx, 'Backlog')); // another column is fine
    expect(getCard(t.ctx, blocked.id).columnId).toBe(columnId(t.ctx, 'Backlog'));
  });
});

describe('moving newly blocked cards to the blocked column', () => {
  const blockedCol = () => columnId(t.ctx, 'Blocked/Waiting');

  it('picks the "Blocked/Waiting" column by default', () => {
    expect(getBlockedColumnId(t.ctx)).toBe(blockedCol());
  });

  it('moves a card there when it gets an open blocker, and logs why', () => {
    const { blocked, blocker } = pair();
    const card = getCard(t.ctx, blocked.id);
    expect(card.columnId).toBe(blockedCol());
    const moved = listActivity(t.ctx, blocked.id).find((e) => e.type === 'moved')!;
    expect(moved.data).toMatchObject({
      from: { name: 'Triage' },
      to: { name: 'Blocked/Waiting' },
      reason: 'blocked',
      blockedBy: [{ id: blocker.id, title: 'Back up Plex database' }],
    });
    // The blocker itself stays where it was.
    expect(getCard(t.ctx, blocker.id).columnId).toBe(columnId(t.ctx, 'Triage'));
  });

  it('works from either side of the link and goes to the bottom of the column', () => {
    const waiting = createCard(t.ctx, { title: 'Already waiting', columnId: blockedCol() });
    const a = createCard(t.ctx, { title: 'A', columnId: columnId(t.ctx, 'In Progress') });
    const b = createCard(t.ctx, { title: 'B' });
    createLink(t.ctx, b.id, a.id, 'blocks'); // created from the blocker's side
    expect(getCard(t.ctx, a.id).columnId).toBe(blockedCol());
    expect(getCard(t.ctx, a.id).position).toBeGreaterThan(getCard(t.ctx, waiting.id).position);
  });

  it("doesn't move cards blocked only by finished cards, done cards, or related links", () => {
    const finished = createCard(t.ctx, { title: 'Finished', columnId: columnId(t.ctx, 'Done') });
    const a = createCard(t.ctx, { title: 'A' });
    createLink(t.ctx, a.id, finished.id, 'blocked_by');
    expect(getCard(t.ctx, a.id).columnId).toBe(columnId(t.ctx, 'Triage'));

    const b = createCard(t.ctx, { title: 'B' });
    createLink(t.ctx, a.id, b.id, 'relates');
    expect(getCard(t.ctx, a.id).columnId).toBe(columnId(t.ctx, 'Triage'));
  });

  it('moves blocked cards again when a blocker is reopened or restored from the Trash', () => {
    const { blocked, blocker } = pair();
    toDone(blocker.id);
    moveCard(t.ctx, blocked.id, { toColumnId: columnId(t.ctx, 'In Progress'), afterCardId: null });

    moveCard(t.ctx, blocker.id, { toColumnId: columnId(t.ctx, 'Backlog'), afterCardId: null }); // reopened
    expect(getCard(t.ctx, blocked.id).columnId).toBe(blockedCol());

    moveCard(t.ctx, blocked.id, { toColumnId: columnId(t.ctx, 'In Progress'), afterCardId: null });
    deleteCard(t.ctx, blocker.id);
    undeleteCard(t.ctx, blocker.id);
    expect(getCard(t.ctx, blocked.id).columnId).toBe(blockedCol());
  });

  it('can be pointed at another column or turned off; Triage and Done are refused', () => {
    const parked = createColumn(t.ctx, 'Parked');
    setBlockedColumn(t.ctx, parked.id);
    const first = pair();
    expect(getCard(t.ctx, first.blocked.id).columnId).toBe(parked.id);

    setBlockedColumn(t.ctx, null);
    const second = pair();
    expect(getCard(t.ctx, second.blocked.id).columnId).toBe(columnId(t.ctx, 'Triage'));

    expect(failure(() => setBlockedColumn(t.ctx, columnId(t.ctx, 'Done'))).code).toBe('invalid_target');
    expect(failure(() => setBlockedColumn(t.ctx, columnId(t.ctx, 'Triage'))).code).toBe('invalid_target');
  });

  it('turns off when the blocked column is deleted', () => {
    deleteColumn(t.ctx, blockedCol(), columnId(t.ctx, 'Backlog'));
    expect(getBlockedColumnId(t.ctx)).toBeNull();
    const { blocked } = pair();
    expect(getCard(t.ctx, blocked.id).columnId).toBe(columnId(t.ctx, 'Triage'));
  });
});

describe('blocked cards over HTTP', () => {
  let app: TestApp;
  afterEach(() => app?.shutdown());

  it('returns 409 blocked with the blockers, and the board shows blockedBy', async () => {
    app = await makeApp();
    const c = client(app.app, await setupAndLogin(app));
    const blocked = (await c('POST', '/api/cards', { title: 'Blocked' })).json();
    const blocker = (await c('POST', '/api/cards', { title: 'Blocker' })).json();
    await c('POST', `/api/cards/${blocked.id}/links`, { otherCardId: blocker.id, direction: 'blocked_by' });

    const board = (await c('GET', '/api/board')).json();
    expect(board.cards.find((x: { id: number }) => x.id === blocked.id)).toMatchObject({
      blockedBy: 1,
      columnId: columnId(app.ctx, 'Blocked/Waiting'),
    });
    expect(board.blockedColumnId).toBe(columnId(app.ctx, 'Blocked/Waiting'));

    // Choosing another column (or none) through the API.
    expect((await c('PUT', '/api/board/blocked-column', { columnId: null })).statusCode).toBe(204);
    expect((await c('GET', '/api/board')).json().blockedColumnId).toBeNull();
    expect((await c('PUT', '/api/board/blocked-column', { columnId: columnId(app.ctx, 'Done') })).statusCode).toBe(400);

    const res = await c('POST', `/api/cards/${blocked.id}/move`, { toColumnId: columnId(app.ctx, 'Done'), afterCardId: null });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'blocked', blockers: [{ id: blocker.id, title: 'Blocker' }] });
  });
});

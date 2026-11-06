import { describe, expect, it } from 'vitest';
import { board, tile } from '../test/fixtures';
import { applyBoardOps, cardsMovedBy, completionBlocked, groupCards, groupedOrder, moveCardsLocally, toTile } from './board';

const titles = (list: { title: string }[]) => list.map((c) => c.title);

describe('groupedOrder', () => {
  it('keeps plain cards in position order', () => {
    const list = [tile({ title: 'A', position: 0 }), tile({ title: 'B', position: 1 })];
    expect(titles(groupedOrder(list))).toEqual(['A', 'B']);
  });

  it("pulls a work card's tickets right after it", () => {
    const w = tile({ title: 'Work', kind: 'work', position: 1 });
    const list = [
      tile({ title: 'Kid 1', parentId: w.id, position: 0 }),
      w,
      tile({ title: 'Other', position: 2 }),
      tile({ title: 'Kid 2', parentId: w.id, position: 3 }),
    ];
    expect(titles(groupedOrder(list))).toEqual(['Work', 'Kid 1', 'Kid 2', 'Other']);
  });

  it('groups tickets whose work card is in another column at the first of them', () => {
    const list = [
      tile({ title: 'A', position: 0 }),
      tile({ title: 'Kid 1', parentId: 999, position: 1 }),
      tile({ title: 'B', position: 2 }),
      tile({ title: 'Kid 2', parentId: 999, position: 3 }),
    ];
    expect(titles(groupedOrder(list))).toEqual(['A', 'Kid 1', 'Kid 2', 'B']);
  });

  it('keeps every card exactly once', () => {
    const w = tile({ kind: 'work' });
    const list = [w, tile({ parentId: w.id }), tile({ parentId: 4242 }), tile()];
    const out = groupedOrder(list);
    expect(out).toHaveLength(list.length);
    expect(new Set(out.map((c) => c.id)).size).toBe(list.length);
  });
});

describe('completionBlocked', () => {
  it('stops a blocked card from entering Done, and only Done', () => {
    const t = tile({ title: 'Swap battery', blockedBy: 2, columnId: 1 });
    const b = board([t]);
    expect(completionBlocked(b, t.id, 3)).toBe('“Swap battery” is blocked by 2 open cards. Finish them first.');
    expect(completionBlocked(b, t.id, 2)).toBeNull();
  });

  it('lets unblocked cards and cards already in Done through', () => {
    const free = tile({ columnId: 1 });
    const inDone = tile({ columnId: 3, blockedBy: 1 });
    const b = board([free, inDone]);
    expect(completionBlocked(b, free.id, 3)).toBeNull();
    expect(completionBlocked(b, inDone.id, 3)).toBeNull();
  });
});

describe('moving several cards as one block', () => {
  const setup = () => {
    const a = tile({ title: 'A', columnId: 1, position: 0 });
    const b = tile({ title: 'B', columnId: 1, position: 1 });
    const c = tile({ title: 'C', columnId: 1, position: 2 });
    const stay = tile({ title: 'Stay', columnId: 1, position: 3 });
    const top = tile({ title: 'Top', columnId: 2, position: 0 });
    const bottom = tile({ title: 'Bottom', columnId: 2, position: 1 });
    return { a, b, c, top, cards: board([a, b, c, stay, top, bottom]) };
  };
  const column = (b: ReturnType<typeof board>, id: number) => titles(groupCards(b).get(id) ?? []);

  it('puts them in order right after the anchor, and closes the gap they left', () => {
    const { a, b, c, top, cards } = setup();
    const next = moveCardsLocally(cards, { cardIds: [a.id, b.id, c.id], toColumnId: 2, afterCardId: top.id });
    expect(column(next, 2)).toEqual(['Top', 'A', 'B', 'C', 'Bottom']);
    expect(column(next, 1)).toEqual(['Stay']);
    expect(groupCards(next).get(2)?.map((x) => x.position)).toEqual([0, 1, 2, 3, 4]);
  });

  it('puts them at the top without an anchor', () => {
    const { a, b, cards } = setup();
    const next = moveCardsLocally(cards, { cardIds: [a.id, b.id], toColumnId: 2, afterCardId: null });
    expect(column(next, 2)).toEqual(['A', 'B', 'Top', 'Bottom']);
  });

  it('marks them complete on the way into Done, like the server', () => {
    const { a, b, cards } = setup();
    const next = moveCardsLocally(cards, { cardIds: [a.id, b.id], toColumnId: 3, afterCardId: null });
    expect(next.cards.filter((x) => x.columnId === 3).every((x) => x.completedAt !== null)).toBe(true);
  });

  it('is replayed when queued, and reports every card it will move', () => {
    const { a, b, cards } = setup();
    const ops = [
      { kind: 'moveMany' as const, vars: { cardIds: [a.id, b.id], toColumnId: 2, afterCardId: null } },
      { kind: 'move' as const, vars: { cardId: 99, toColumnId: 1, afterCardId: null } },
      { kind: 'create' as const, vars: { title: 'New', columnId: 1, tempId: -1 } },
    ];
    expect(column(applyBoardOps(cards, ops.slice(0, 1)), 2)).toEqual(['A', 'B', 'Top', 'Bottom']);
    expect([...cardsMovedBy(ops)].sort((x, y) => x - y)).toEqual([a.id, b.id, 99].sort((x, y) => x - y));
  });
});

describe('toTile', () => {
  it('keeps every tile field (and only those)', () => {
    const t = tile({ kind: 'work', childCount: 3, childOpen: 1, blockedBy: 1 });
    expect(toTile({ ...t, description: 'x' } as never)).toEqual(t);
  });
});

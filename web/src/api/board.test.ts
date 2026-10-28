import { describe, expect, it } from 'vitest';
import { board, tile } from '../test/fixtures';
import { completionBlocked, groupedOrder, toTile } from './board';

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

describe('toTile', () => {
  it('keeps every tile field (and only those)', () => {
    const t = tile({ kind: 'work', childCount: 3, childOpen: 1, blockedBy: 1 });
    expect(toTile({ ...t, description: 'x' } as never)).toEqual(t);
  });
});

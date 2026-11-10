import { describe, expect, it } from 'vitest';
import { board, tile } from '../test/fixtures';
import { byPriorityThenAge, initials, mineCards, unassignedCards } from './assignees';

const ME = 4;
const ids = (cards: { id: number }[]) => cards.map((c) => c.id);

describe('Mine and Unassigned', () => {
  // Ids count up as cards are created: a lower id is an older card.
  const cards = [
    tile({ id: 10, assigneeId: null, priority: 'low' }),
    tile({ id: 11, assigneeId: null, priority: null }),
    tile({ id: 12, assigneeId: null, priority: 'critical', columnId: 2 }),
    tile({ id: 13, assigneeId: null, priority: 'low', columnId: 2 }),
    tile({ id: 14, assigneeId: null, priority: 'critical', completedAt: '2026-10-27T15:00:00.000Z', columnId: 3 }), // done
    tile({ id: 15, assigneeId: ME, priority: 'medium' }),
    tile({ id: 16, assigneeId: ME, priority: 'high', columnId: 2 }),
    tile({ id: 17, assigneeId: ME, priority: 'high', completedAt: '2026-10-27T15:00:00.000Z', columnId: 3 }), // done
    tile({ id: 18, assigneeId: 5, priority: 'critical' }), // someone else's
    tile({ id: 2, assigneeId: null, priority: 'low' }), // oldest
    tile({ id: -1, assigneeId: null, priority: null }), // still being created
  ];

  it('Unassigned: open cards nobody has, from every column, by priority then oldest first', () => {
    expect(ids(unassignedCards(board(cards)))).toEqual([12, 2, 10, 13, 11]);
  });

  it('Mine: my open cards only, sorted the same way', () => {
    expect(ids(mineCards(board(cards), ME))).toEqual([16, 15]);
    expect(mineCards(board(cards), 99)).toEqual([]);
  });

  it('cards without a priority go after P3; ties go to the older card', () => {
    const sorted = [tile({ id: 3, priority: null }), tile({ id: 2, priority: 'low' }), tile({ id: 1, priority: null })].sort(byPriorityThenAge);
    expect(ids(sorted)).toEqual([2, 1, 3]);
  });
});

describe('initials', () => {
  it('takes the first and last word, or the first two letters of one word', () => {
    expect(initials('Alex Chen')).toBe('AC');
    expect(initials('Mary Ann de Vries')).toBe('MV');
    expect(initials('sam')).toBe('SA');
    expect(initials('  ')).toBe('?');
    expect(initials('Åsa Öberg')).toBe('ÅÖ');
  });
});

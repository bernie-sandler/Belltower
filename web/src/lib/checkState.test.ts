import { describe, expect, it } from 'vitest';
import { cardDetail, checklistItem } from '../test/fixtures';
import { countItems, itemStateIn, nextState, withItemState } from './checkState';

describe('nextState', () => {
  it('cycles open → done → failed → unverified → open', () => {
    expect(nextState('open')).toBe('done');
    expect(nextState('done')).toBe('failed');
    expect(nextState('failed')).toBe('unverified');
    expect(nextState('unverified')).toBe('open');
  });
});

describe('countItems', () => {
  it('counts done and failed as answered, unverified separately', () => {
    const items = [checklistItem(1, 'done'), checklistItem(2, 'failed'), checklistItem(3, 'unverified'), checklistItem(4)];
    expect(countItems([{ items }])).toEqual({ done: 2, failed: 1, unverified: 1, total: 4 });
  });
});

describe('withItemState', () => {
  const card = cardDetail([checklistItem(1, 'done'), checklistItem(2, 'failed'), checklistItem(3)], {
    checklistDone: 2,
    checklistFailed: 1,
  });

  it('marks the item and recomputes every count from the items', () => {
    const next = withItemState(card, 3, 'unverified');
    expect(itemStateIn(next, 3)).toBe('unverified');
    expect(next.checklists[0]!.items[2]!.checked).toBe(false);
    expect([next.checklistDone, next.checklistFailed, next.checklistUnverified]).toEqual([2, 1, 1]);

    const fixed = withItemState(next, 2, 'done');
    expect(fixed.checklists[0]!.items[1]!.checked).toBe(true);
    expect([fixed.checklistDone, fixed.checklistFailed, fixed.checklistUnverified]).toEqual([2, 0, 1]);

    const reopened = withItemState(fixed, 1, 'open');
    expect([reopened.checklistDone, reopened.checklistFailed, reopened.checklistUnverified]).toEqual([1, 0, 1]);
  });

  it('corrects counts that drifted, and leaves the card alone for an unknown item', () => {
    const drifted = { ...card, checklistDone: 7 };
    expect(withItemState(drifted, 1, 'done').checklistDone).toBe(2);
    expect(withItemState(card, 99, 'done')).toBe(card);
  });

  it('reads an item’s state from a card, or null', () => {
    expect(itemStateIn(card, 2)).toBe('failed');
    expect(itemStateIn(card, 99)).toBeNull();
    expect(itemStateIn(undefined, 1)).toBeNull();
  });
});

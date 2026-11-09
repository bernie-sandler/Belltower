// Checklist item marks. Clicking an item cycles open → done (✓) → failed (✗) → unverified (~) → open.
// Progress counts done and failed as answered; unverified stays open.

import type { CardDetail, Checklist, ChecklistItemState } from '@tt/shared';

const NEXT: Record<ChecklistItemState, ChecklistItemState> = {
  open: 'done',
  done: 'failed',
  failed: 'unverified',
  unverified: 'open',
};

export function nextState(state: ChecklistItemState): ChecklistItemState {
  return NEXT[state];
}

/** For tooltips: "Failed / No — click for Unverified". */
export const STATE_LABELS: Record<ChecklistItemState, string> = {
  open: 'Not checked',
  done: 'Done',
  failed: 'Failed / No',
  unverified: 'Unverified',
};

/** Read after the item's text by screen readers: "Order battery, failed". */
export const STATE_SPOKEN: Record<ChecklistItemState, string> = {
  open: 'not checked',
  done: 'done',
  failed: 'failed',
  unverified: 'unverified',
};

export interface ChecklistCounts {
  /** Answered: done plus failed. */
  done: number;
  failed: number;
  unverified: number;
  total: number;
}

export function countItems(lists: Pick<Checklist, 'items'>[]): ChecklistCounts {
  const c: ChecklistCounts = { done: 0, failed: 0, unverified: 0, total: 0 };
  for (const list of lists) {
    for (const item of list.items) {
      c.total++;
      if (item.state === 'done' || item.state === 'failed') c.done++;
      if (item.state === 'failed') c.failed++;
      if (item.state === 'unverified') c.unverified++;
    }
  }
  return c;
}

/** The card with one item re-marked and its checklist counts recomputed from every item. */
export function withItemState(card: CardDetail, itemId: number, state: ChecklistItemState): CardDetail {
  if (!card.checklists.some((l) => l.items.some((i) => i.id === itemId))) return card;
  const checklists = card.checklists.map((l) => ({
    ...l,
    items: l.items.map((i) => (i.id === itemId ? { ...i, state, checked: state === 'done' } : i)),
  }));
  const counts = countItems(checklists);
  return {
    ...card,
    checklists,
    checklistDone: counts.done,
    checklistFailed: counts.failed,
    checklistUnverified: counts.unverified,
  };
}

/** The item's mark as the cached card shows it, or null when the card or item isn't there. */
export function itemStateIn(card: CardDetail | undefined, itemId: number): ChecklistItemState | null {
  for (const list of card?.checklists ?? []) {
    const item = list.items.find((i) => i.id === itemId);
    if (item) return item.state;
  }
  return null;
}

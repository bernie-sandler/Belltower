// Assignees in the browser: initials for the tile badge, and the Mine and Unassigned lists. The
// lists are worked out from the board query, which already holds every card that isn't archived
// or in the Trash, so they need no endpoint of their own.

import { PRIORITIES, type BoardResponse, type CardTile } from '@tt/shared';

/** "Alex Chen" → "AC", "sam" → "SA": two letters for the tile badge. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const letters = words.length > 1 ? [...words[0]!][0]! + [...words[words.length - 1]!][0]! : [...words[0]!].slice(0, 2).join('');
  return letters.toUpperCase();
}

/** Still to do: not completed, and saved (not an optimistic tile that is being created). */
export function isOpen(tile: CardTile): boolean {
  return tile.completedAt === null && tile.id > 0;
}

const priorityRank = (tile: CardTile) => (tile.priority === null ? PRIORITIES.length : PRIORITIES.indexOf(tile.priority));

/**
 * P0 → P3, cards without a priority last; then oldest first. Card ids count up as cards are
 * created (a restore keeps them), so a lower id is an older card.
 */
export function byPriorityThenAge(a: CardTile, b: CardTile): number {
  return priorityRank(a) - priorityRank(b) || a.id - b.id;
}

/** "Mine": my open cards. */
export function mineCards(board: BoardResponse, meId: number): CardTile[] {
  return board.cards.filter((c) => isOpen(c) && c.assigneeId === meId).sort(byPriorityThenAge);
}

/** "Unassigned": every open card nobody has, from any column. */
export function unassignedCards(board: BoardResponse): CardTile[] {
  return board.cards.filter((c) => isOpen(c) && c.assigneeId === null).sort(byPriorityThenAge);
}

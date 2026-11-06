// Drag-and-drop ids and configuration shared by the board.

import {
  closestCenter,
  closestCorners,
  MeasuringStrategy,
  pointerWithin,
  type Collision,
  type CollisionDetection,
  type DropAnimation,
  type KeyboardCodes,
  type KeyboardCoordinateGetter,
  type MeasuringConfiguration,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';

export const cardDndId = (id: number): string => `card:${id}`;
export const columnDndId = (id: number): string => `col:${id}`;
/**
 * A folder header (tickets whose work card is in another column). Named after its first ticket,
 * so the id stays the same when the folder is dragged into another column and re-rendered there.
 */
export const groupDndId = (parentId: number, firstId: number): string => `group:${parentId}:${firstId}`;

export function parseGroupDndId(id: UniqueIdentifier): { parentId: number; firstId: number } | null {
  const [kind, parent, first] = String(id).split(':');
  const parentId = Number(parent);
  const firstId = Number(first);
  if (kind !== 'group' || !Number.isFinite(parentId) || !Number.isFinite(firstId)) return null;
  return { parentId, firstId };
}

export function parseDndId(id: UniqueIdentifier): { kind: 'card' | 'col'; id: number } | null {
  const [kind, raw] = String(id).split(':');
  const n = Number(raw);
  if ((kind !== 'card' && kind !== 'col') || !Number.isFinite(n)) return null;
  return { kind, id: n };
}

const isColumnId = (id: UniqueIdentifier) => String(id).startsWith('col:');
const isCardId = (id: UniqueIdentifier) => String(id).startsWith('card:');

function sortableContainerOf(data: unknown): UniqueIdentifier | undefined {
  return (data as { sortable?: { containerId?: UniqueIdentifier } } | undefined)?.sortable?.containerId;
}

/** The last target of the current drag, kept while the pointer is between columns. */
let lastOver: { active: UniqueIdentifier; over: UniqueIdentifier } | null = null;

/**
 * Which column is targeted depends only on the pointer's x position, never on card layout. (An
 * overlap-based fallback can pick the other column after each layout shift, so onDragOver would
 * move the card back and forth on its own until React gives up with "maximum update depth".)
 *
 *  - Pointer on a card: that card.
 *  - Pointer in a column (gap between cards, header, below the last card, or below a short
 *    column): the nearest card of that column, so sorted items don't spring back whenever the
 *    pointer crosses a gap. An empty column is itself the target.
 *  - Pointer between columns or off the board: keep the previous target (what's shown stays
 *    what a drop does).
 *  - Keyboard drags have no pointer and use closest corners, which sortableKeyboardCoordinates
 *    expects.
 */
export const collisionDetection: CollisionDetection = (args) => {
  const pointer = args.pointerCoordinates;
  if (!pointer) return closestCorners(args);

  const remember = (collisions: Collision[]): Collision[] => {
    const first = collisions[0];
    if (first) lastOver = { active: args.active.id, over: first.id };
    return collisions;
  };

  const within = pointerWithin(args);
  const cards = within.filter((c) => isCardId(c.id));
  if (cards.length > 0) return remember(cards);

  let columnId = within.find((c) => isColumnId(c.id))?.id;
  if (columnId === undefined) {
    for (const container of args.droppableContainers) {
      if (!isColumnId(container.id)) continue;
      const rect = args.droppableRects.get(container.id);
      if (rect && pointer.x >= rect.left && pointer.x <= rect.right) {
        columnId = container.id;
        break;
      }
    }
  }
  if (columnId === undefined) {
    const keep = lastOver?.active === args.active.id ? lastOver.over : undefined;
    return keep !== undefined && args.droppableRects.has(keep) ? [{ id: keep }] : [];
  }

  const inColumn = args.droppableContainers.filter((c) => sortableContainerOf(c.data.current) === columnId);
  return remember(inColumn.length > 0 ? closestCenter({ ...args, droppableContainers: inColumn }) : [{ id: columnId }]);
};

/** Re-measure droppables continuously: cards move between columns mid-drag. */
export const measuring: MeasuringConfiguration = {
  droppable: { strategy: MeasuringStrategy.Always },
};

export const autoScroll = { threshold: { x: 0.15, y: 0.1 } };

const ARROW_STEP: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: 0, ArrowDown: 0 };

/**
 * Arrow keys while dragging. Cards use dnd-kit's sortable steps, which only work for sortable
 * items. A folder header isn't one, so left and right take it to the next column; up and down do
 * nothing, because a folder stays where it entered a column (see useBoardDnd).
 */
export const keyboardCoordinates: KeyboardCoordinateGetter = (event, args) => {
  if (!parseGroupDndId(args.active)) return sortableKeyboardCoordinates(event, args);
  const step = ARROW_STEP[event.code];
  if (step === undefined) return undefined;
  event.preventDefault();
  const { collisionRect, droppableContainers, droppableRects } = args.context;
  if (!collisionRect) return undefined;
  const columns = droppableContainers
    .getEnabled()
    .filter((c) => isColumnId(c.id))
    .flatMap((c) => droppableRects.get(c.id) ?? [])
    .sort((a, b) => a.left - b.left);
  const middle = collisionRect.left + collisionRect.width / 2;
  const here = columns.findIndex((r) => middle >= r.left && middle <= r.right);
  const from = columns[here];
  const to = columns[here + step];
  if (!from || !to || to === from) return undefined;
  return { x: args.currentCoordinates.x + to.left - from.left, y: args.currentCoordinates.y };
};

/** Space picks up / drops; Enter stays free to open the card. */
export const keyboardCodes: KeyboardCodes = {
  start: ['Space'],
  cancel: ['Escape'],
  end: ['Space', 'Enter'],
};

export const dropAnimation: DropAnimation = { duration: 150, easing: 'ease-out' };

// Board drag-and-drop state.
//
// While dragging, the board renders card order from a local copy (`items`), so refetches can't
// yank cards around under the pointer. onDragOver moves the card between columns in that copy
// only; onDragEnd sends exactly one move (toColumnId + afterCardId). After the drop the local
// order stays on screen until the optimistic cache update arrives ("settle"), so the card never
// flickers back to its old spot.
//
// A folder header (tickets whose work card is in another column) drags its tickets as one block:
// they move together in the local copy, and the drop sends them all in one request, so a failure
// can't leave the folder split between columns.

import type { DragEndEvent, DragOverEvent, DragStartEvent } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import type { BoardResponse, Column } from '@tt/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { groupCards, groupedOrder } from '../../api/board';
import type { MoveCardsVars, MoveVars } from '../../api/cards';
import { setDragging } from '../../lib/dragging';
import { parseDndId, parseGroupDndId } from './dnd';

/** Column id → ordered ids of saved (non-temporary) cards. */
export type Items = Map<number, number[]>;

interface DragState {
  /** The dragged cards in order: one card, or a folder's tickets. */
  activeIds: number[];
  /** Set when a folder is dragged. */
  group: { parentId: number; firstId: number } | null;
  items: Items;
  originColumn: number;
  originAfter: number | null;
}

function itemsFromBoard(board: BoardResponse, columns: Column[]): Items {
  const groups = groupCards(board);
  const items: Items = new Map();
  for (const col of columns) {
    items.set(
      col.id,
      groupedOrder((groups.get(col.id) ?? []).filter((c) => c.id > 0)).map((c) => c.id),
    );
  }
  return items;
}

export function findColumn(items: Items, cardId: number): number | null {
  for (const [col, ids] of items) if (ids.includes(cardId)) return col;
  return null;
}

export function useBoardDnd(
  board: BoardResponse,
  columns: Column[],
  onMove: (move: MoveVars, onSettled: () => void) => void,
  onMoveGroup: (move: MoveCardsVars, onSettled: () => void) => void,
) {
  const derived = useMemo(() => itemsFromBoard(board, columns), [board, columns]);
  const dragRef = useRef<DragState | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [settle, setSettle] = useState<{ items: Items; base: BoardResponse } | null>(null);

  const items: Items = drag?.items ?? (settle && settle.base === board ? settle.items : derived);

  const update = (next: DragState | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  // Once the cache reflects the move (or anything else changes), drop the settle copy.
  useEffect(() => {
    if (settle && settle.base !== board) setSettle(null);
  }, [board, settle]);

  // Never leave the global flag stuck if the board unmounts mid-drag.
  useEffect(() => () => setDragging(false), []);

  const finish = () => {
    update(null);
    setDragging(false);
  };

  const onDragStart = ({ active, activatorEvent }: DragStartEvent) => {
    const group = parseGroupDndId(active.id);
    const parsed = group ? null : parseDndId(active.id);
    const first = group?.firstId ?? (parsed?.kind === 'card' ? parsed.id : null);
    if (first === null) return;
    const col = findColumn(items, first);
    if (col === null) return;
    const list = items.get(col) ?? [];
    let activeIds = [first];
    if (group) {
      // The folder's tickets in this column (collapsed ones too: they're still in the list).
      const kids = new Set(board.cards.filter((c) => c.parentId === group.parentId).map((c) => c.id));
      activeIds = list.filter((id) => kids.has(id));
    }
    const index = list.indexOf(first);
    update({
      activeIds,
      group,
      items: new Map(items),
      originColumn: col,
      originAfter: index > 0 ? (list[index - 1] ?? null) : null,
    });
    setSettle(null);
    setDragging(true, !(activatorEvent instanceof KeyboardEvent));
  };

  const onDragOver = ({ active, over }: DragOverEvent) => {
    const state = dragRef.current;
    if (!state || !over) return;
    const target = parseDndId(over.id);
    if (!target) return;
    const moving = new Set(state.activeIds);
    if (target.kind === 'card' && moving.has(target.id)) return;
    const from = findColumn(state.items, state.activeIds[0]!);
    const to = target.kind === 'col' ? target.id : findColumn(state.items, target.id);
    if (from === null || to === null || from === to) return;

    const fromList = state.items.get(from) ?? [];
    const toList = state.items.get(to) ?? [];
    let index = toList.length; // over the column itself → bottom
    if (target.kind === 'card') {
      const overIndex = toList.indexOf(target.id);
      const rect = active.rect.current.translated;
      const below = rect !== null && rect.top + rect.height / 2 > over.rect.top + over.rect.height / 2;
      if (overIndex >= 0) index = overIndex + (below ? 1 : 0);
    }
    const next: Items = new Map(state.items);
    next.set(from, fromList.filter((id) => !moving.has(id)));
    next.set(to, [...toList.slice(0, index), ...state.activeIds, ...toList.slice(index)]);
    update({ ...state, items: next });
  };

  const onDragEnd = ({ over }: DragEndEvent) => {
    const state = dragRef.current;
    finish();
    if (!state || !over) return; // dropped outside the board: nothing changes

    let finalItems = state.items;
    const activeId = state.activeIds[0]!;
    const col = findColumn(finalItems, activeId);
    if (col === null) return;
    const target = parseDndId(over.id);
    if (!state.group && target?.kind === 'card' && target.id !== activeId) {
      // Within-column reorder: the sortable strategy only moved things visually. (Folders aren't
      // sortable items, so within their own column they stay put.)
      const list = finalItems.get(col) ?? [];
      const fromIndex = list.indexOf(activeId);
      const toIndex = list.indexOf(target.id);
      if (toIndex >= 0 && fromIndex !== toIndex) {
        finalItems = new Map(finalItems);
        finalItems.set(col, arrayMove(list, fromIndex, toIndex));
      }
    }

    const list = finalItems.get(col) ?? [];
    const index = list.indexOf(activeId);
    const afterCardId = index > 0 ? (list[index - 1] ?? null) : null;
    if (col === state.originColumn && afterCardId === state.originAfter) return; // no change

    setSettle({ items: finalItems, base: board });
    if (state.group) onMoveGroup({ cardIds: state.activeIds, toColumnId: col, afterCardId }, () => setSettle(null));
    else onMove({ cardId: activeId, toColumnId: col, afterCardId }, () => setSettle(null));
  };

  const onDragCancel = () => finish();

  return {
    items,
    /** The dragged card (null while a folder is dragged). */
    activeId: drag && !drag.group ? drag.activeIds[0]! : null,
    /** The dragged folder: its work card and how many tickets come along. */
    activeGroup: drag?.group ? { parentId: drag.group.parentId, count: drag.activeIds.length } : null,
    isDragging: drag !== null,
    handlers: { onDragStart, onDragOver, onDragEnd, onDragCancel },
  };
}

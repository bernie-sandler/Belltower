// Board drag-and-drop state.
//
// While dragging, the board renders card order from a local copy (`items`), so refetches can't
// yank cards around under the pointer. onDragOver moves the card between columns in that copy
// only; onDragEnd sends exactly one move (toColumnId + afterCardId). After the drop the local
// order stays on screen until the optimistic cache update arrives ("settle"), so the card never
// flickers back to its old spot.

import type { DragEndEvent, DragOverEvent, DragStartEvent } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import type { BoardResponse, Column } from '@tt/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { groupCards } from '../../api/board';
import type { MoveVars } from '../../api/cards';
import { setDragging } from '../../lib/dragging';
import { parseDndId } from './dnd';

/** Column id → ordered ids of saved (non-temporary) cards. */
export type Items = Map<number, number[]>;

interface DragState {
  activeId: number;
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
      (groups.get(col.id) ?? []).filter((c) => c.id > 0).map((c) => c.id),
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
    const parsed = parseDndId(active.id);
    if (!parsed || parsed.kind !== 'card') return;
    const col = findColumn(items, parsed.id);
    if (col === null) return;
    const list = items.get(col) ?? [];
    const index = list.indexOf(parsed.id);
    update({
      activeId: parsed.id,
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
    const from = findColumn(state.items, state.activeId);
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
    next.set(from, fromList.filter((id) => id !== state.activeId));
    next.set(to, [...toList.slice(0, index), state.activeId, ...toList.slice(index)]);
    update({ ...state, items: next });
  };

  const onDragEnd = ({ over }: DragEndEvent) => {
    const state = dragRef.current;
    finish();
    if (!state || !over) return; // dropped outside the board: nothing changes

    let finalItems = state.items;
    const col = findColumn(finalItems, state.activeId);
    if (col === null) return;
    const target = parseDndId(over.id);
    if (target?.kind === 'card' && target.id !== state.activeId) {
      // Within-column reorder: the sortable strategy only moved things visually.
      const list = finalItems.get(col) ?? [];
      const fromIndex = list.indexOf(state.activeId);
      const toIndex = list.indexOf(target.id);
      if (toIndex >= 0 && fromIndex !== toIndex) {
        finalItems = new Map(finalItems);
        finalItems.set(col, arrayMove(list, fromIndex, toIndex));
      }
    }

    const list = finalItems.get(col) ?? [];
    const index = list.indexOf(state.activeId);
    const afterCardId = index > 0 ? (list[index - 1] ?? null) : null;
    if (col === state.originColumn && afterCardId === state.originAfter) return; // no change

    setSettle({ items: finalItems, base: board });
    onMove({ cardId: state.activeId, toColumnId: col, afterCardId }, () => setSettle(null));
  };

  const onDragCancel = () => finish();

  return {
    items,
    activeId: drag?.activeId ?? null,
    isDragging: drag !== null,
    handlers: { onDragStart, onDragOver, onDragEnd, onDragCancel },
  };
}

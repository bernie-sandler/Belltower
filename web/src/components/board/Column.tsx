import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { CardTile, Column as ColumnType, Label } from '@tt/shared';
import { ChevronDown, ChevronRight, FolderOpen, Plus } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { cls } from '../../lib/cls';
import { AddCardComposer } from './AddCardComposer';
import { ColumnHeader } from './ColumnHeader';
import { cardDndId, columnDndId } from './dnd';
import { SortableTile, TileView } from './Tile';

/**
 * Done keeps every card ever finished, so it only shows the most recent ones until asked. Hidden
 * cards stay in cardIds (like a collapsed group), so drops still land in the right place.
 */
export const DONE_SHOWN = 50;

interface Props {
  column: ColumnType;
  columns: ColumnType[];
  index: number;
  /** Saved cards in display order (from the drag-aware item list). */
  cardIds: number[];
  /** Optimistic cards still being created; always shown at the bottom. */
  pendingTiles: CardTile[];
  /** Every card on the board (work cards in other columns label their groups here). */
  tilesById: Map<number, CardTile>;
  /** Work cards whose tickets are hidden. */
  collapsed: Set<number>;
  onToggleGroup: (workCardId: number) => void;
  labelsById: Map<number, Label>;
  now: number;
  composerOpen: boolean;
  onOpenComposer: (columnId: number) => void;
  onCloseComposer: () => void;
  onOpenCard: (id: number) => void;
  onTileMenu: (id: number, anchor: HTMLElement) => void;
  /** The card whose ⋯ menu is open (for aria-expanded), if any. */
  menuCardId: number | null;
  registerElement: (columnId: number, el: HTMLElement | null) => void;
}

export const Column = memo(function Column({
  column,
  columns,
  index,
  cardIds,
  pendingTiles,
  tilesById,
  collapsed,
  onToggleGroup,
  labelsById,
  now,
  composerOpen,
  onOpenComposer,
  onCloseComposer,
  onOpenCard,
  onTileMenu,
  menuCardId,
  registerElement,
}: Props) {
  // The whole column accepts drops, so empty columns and the header area work as targets.
  const { setNodeRef } = useDroppable({ id: columnDndId(column.id), data: { type: 'column', columnId: column.id } });
  // Rows in display order: cards, plus a header where a group of tickets starts whose work card is
  // in another column. Tickets of a collapsed group aren't rendered (or sortable), but stay in
  // cardIds so drop positions are still computed against the real order.
  const rows = useMemo(() => {
    const here = new Set(cardIds);
    const out: ({ kind: 'card'; id: number; nested: boolean; group?: { count: number } } | { kind: 'header'; parentId: number; count: number })[] = [];
    let open: number | null = null;
    for (const id of cardIds) {
      const tile = tilesById.get(id);
      if (!tile) continue;
      const parent = tile.parentId;
      if (parent !== null && !here.has(parent) && open !== parent) {
        out.push({ kind: 'header', parentId: parent, count: cardIds.filter((x) => tilesById.get(x)?.parentId === parent).length });
      }
      open = parent ?? (tile.kind === 'work' ? tile.id : null);
      if (parent !== null && collapsed.has(parent)) continue;
      const count = tile.kind === 'work' ? cardIds.filter((x) => tilesById.get(x)?.parentId === tile.id).length : 0;
      out.push({ kind: 'card', id, nested: parent !== null, ...(count ? { group: { count } } : {}) });
    }
    return out;
  }, [cardIds, tilesById, collapsed]);
  const [showAll, setShowAll] = useState(false);
  const { shownRows, hidden } = useMemo(() => {
    const cards = rows.filter((r) => r.kind === 'card').length;
    if (column.role !== 'done' || showAll || cards <= DONE_SHOWN) return { shownRows: rows, hidden: 0 };
    let n = 0;
    const cut = rows.findIndex((r) => r.kind === 'card' && ++n > DONE_SHOWN);
    // A group header with nothing shown under it goes too.
    const shown = rows.slice(0, cut);
    while (shown.length && shown[shown.length - 1]!.kind === 'header') shown.pop();
    return { shownRows: shown, hidden: cards - DONE_SHOWN };
  }, [rows, column.role, showAll]);
  const sortableIds = useMemo(() => shownRows.flatMap((r) => (r.kind === 'card' ? [cardDndId(r.id)] : [])), [shownRows]);
  const count = cardIds.length + pendingTiles.length;
  const nameId = `column-name-${column.id}`;

  const ref = useCallback(
    (el: HTMLElement | null) => {
      setNodeRef(el);
      registerElement(column.id, el);
    },
    [setNodeRef, registerElement, column.id],
  );

  return (
    <section
      ref={ref}
      className={cls('column', column.role && `column-${column.role}`)}
      aria-labelledby={nameId}
      data-column-index={index}
    >
      <ColumnHeader column={column} columns={columns} index={index} cardCount={count} nameId={nameId} />

      <div className="column-cards">
        <SortableContext id={columnDndId(column.id)} items={sortableIds} strategy={verticalListSortingStrategy}>
          {shownRows.map((row) => {
            if (row.kind === 'header') {
              const parent = tilesById.get(row.parentId);
              const isCollapsed = collapsed.has(row.parentId);
              return (
                <div key={`group-${row.parentId}`} className="group-header">
                  <button
                    type="button"
                    className="group-toggle"
                    aria-expanded={!isCollapsed}
                    onClick={() => onToggleGroup(row.parentId)}
                  >
                    {isCollapsed ? <ChevronRight size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
                    <FolderOpen size={14} aria-hidden />
                    <span className="group-title">
                      {parent?.ticketNo && <span className="ticket-no">{parent.ticketNo}</span>} {parent?.title ?? 'Work card'}
                    </span>
                    <span className="group-count">{row.count}</span>
                  </button>
                  <button type="button" className="link-btn group-open" onClick={() => onOpenCard(row.parentId)}>
                    Open
                  </button>
                </div>
              );
            }
            const tile = tilesById.get(row.id)!;
            const isCollapsed = collapsed.has(row.id);
            return (
              <div key={row.id} className={cls('tile-row', row.nested && 'is-nested')}>
                <SortableTile
                  tile={tile}
                  labelsById={labelsById}
                  now={now}
                  menuOpen={menuCardId === row.id}
                  onOpen={onOpenCard}
                  onMenu={onTileMenu}
                />
                {row.group && (
                  <button
                    type="button"
                    className="group-toggle group-toggle-local"
                    aria-expanded={!isCollapsed}
                    onClick={() => onToggleGroup(row.id)}
                  >
                    {isCollapsed ? <ChevronRight size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
                    {isCollapsed ? `${row.group.count} ticket${row.group.count === 1 ? '' : 's'} hidden` : `${row.group.count} ticket${row.group.count === 1 ? '' : 's'}`}
                  </button>
                )}
              </div>
            );
          })}
        </SortableContext>
        {hidden > 0 && (
          <button type="button" className="btn btn-sm btn-subtle column-show-older" onClick={() => setShowAll(true)}>
            Show {hidden} older card{hidden === 1 ? '' : 's'}
          </button>
        )}
        {pendingTiles.map((tile) => (
          <div key={tile.id} className="tile-slot" aria-busy="true">
            <TileView tile={tile} labelsById={labelsById} now={now} pending />
          </div>
        ))}
        {composerOpen && <AddCardComposer columnId={column.id} cardCount={count} onClose={onCloseComposer} />}
      </div>

      {!composerOpen && (
        <button type="button" className="column-add-card" onClick={() => onOpenComposer(column.id)}>
          <Plus size={16} aria-hidden /> Add a card
        </button>
      )}
    </section>
  );
});

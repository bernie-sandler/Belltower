import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { CardTile, Column as ColumnType, Label } from '@tt/shared';
import { Plus } from 'lucide-react';
import { memo, useCallback, useMemo } from 'react';
import { cls } from '../../lib/cls';
import { AddCardComposer } from './AddCardComposer';
import { ColumnHeader } from './ColumnHeader';
import { cardDndId, columnDndId } from './dnd';
import { SortableTile, TileView } from './Tile';

interface Props {
  column: ColumnType;
  columns: ColumnType[];
  index: number;
  /** Saved cards in display order (from the drag-aware item list). */
  cardIds: number[];
  /** Optimistic cards still being created; always shown at the bottom. */
  pendingTiles: CardTile[];
  tilesById: Map<number, CardTile>;
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
  const sortableIds = useMemo(() => cardIds.map(cardDndId), [cardIds]);
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
          {cardIds.map((id) => {
            const tile = tilesById.get(id);
            return tile ? (
              <SortableTile
                key={id}
                tile={tile}
                labelsById={labelsById}
                now={now}
                menuOpen={menuCardId === id}
                onOpen={onOpenCard}
                onMenu={onTileMenu}
              />
            ) : null;
          })}
        </SortableContext>
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

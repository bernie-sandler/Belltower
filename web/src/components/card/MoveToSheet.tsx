// "Move to…": the one place (besides drag and drop) to move a card. A bottom sheet on phones and
// a small dialog on desktop. Pick a column, then Top or Bottom; or one-tap "Mark done".

import { ArrowDownToLine, ArrowLeft, ArrowUpToLine, ChevronRight, CircleCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { bottomAnchor, currentAnchor, groupCards, sortedColumns, useBoard } from '../../api/board';
import { useMoveCard } from '../../api/cards';
import { cls } from '../../lib/cls';
import { toast } from '../../lib/toast';
import { Modal } from '../common/Modal';
import { Spinner } from '../common/Status';

interface Props {
  cardId: number;
  onClose: () => void;
}

export function MoveToSheet({ cardId, onClose }: Props) {
  const { data: board } = useBoard();
  const moveCard = useMoveCard();
  const [selected, setSelected] = useState<number | null>(null);
  const topRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const lastSelected = useRef<number | null>(null);

  // Keep keyboard focus sensible when switching between the two steps.
  useEffect(() => {
    if (selected !== null) {
      lastSelected.current = selected;
      topRef.current?.focus({ preventScroll: true });
    } else if (lastSelected.current !== null) {
      listRef.current?.querySelector<HTMLElement>(`[data-column-id="${lastSelected.current}"]`)?.focus({ preventScroll: true });
    }
  }, [selected]);

  if (!board) {
    return (
      <Modal title="Move card" variant="sheet" size="sm" onClose={onClose}>
        <div className="modal-body">
          <Spinner />
        </div>
      </Modal>
    );
  }

  const tile = board.cards.find((c) => c.id === cardId);
  const columns = sortedColumns(board.columns);
  const groups = groupCards(board);
  const doneColumn = columns.find((c) => c.role === 'done');
  const selectedColumn = columns.find((c) => c.id === selected);

  function move(toColumnId: number, where: 'top' | 'bottom') {
    if (!board || !tile) return;
    const afterCardId = where === 'top' ? null : bottomAnchor(board, toColumnId, cardId);
    const unchanged = toColumnId === tile.columnId && afterCardId === currentAnchor(board, cardId);
    onClose();
    if (unchanged) return;
    moveCard.mutate({ cardId, toColumnId, afterCardId });
    const name = columns.find((c) => c.id === toColumnId)?.name ?? 'column';
    if (toColumnId !== tile.columnId) toast(`Moved to ${name}`, { kind: 'success', durationMs: 2500 });
  }

  if (!tile) {
    return (
      <Modal title="Move card" variant="sheet" size="sm" onClose={onClose}>
        <div className="modal-body">
          <p>This card isn&apos;t on the board (it may be archived or in Trash).</p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={selectedColumn ? `Move to ${selectedColumn.name}` : 'Move card'}
      variant="sheet"
      size="sm"
      onClose={onClose}
      initialFocus="panel"
    >
      <div className="modal-body move-sheet">
        {selectedColumn ? (
          <>
            <button type="button" className="btn btn-subtle move-back" onClick={() => setSelected(null)}>
              <ArrowLeft size={16} aria-hidden /> All columns
            </button>
            <div className="move-positions">
              <button ref={topRef} type="button" className="move-position" onClick={() => move(selectedColumn.id, 'top')}>
                <ArrowUpToLine size={20} aria-hidden />
                <span>Top</span>
              </button>
              <button type="button" className="move-position" onClick={() => move(selectedColumn.id, 'bottom')}>
                <ArrowDownToLine size={20} aria-hidden />
                <span>Bottom</span>
              </button>
            </div>
          </>
        ) : (
          <>
            {doneColumn && tile.columnId !== doneColumn.id && (
              <button type="button" className="btn btn-success btn-block move-done" onClick={() => move(doneColumn.id, 'top')}>
                <CircleCheck size={18} aria-hidden /> Mark done
              </button>
            )}
            <ul ref={listRef} className="move-columns" aria-label="Columns">
              {columns.map((c) => {
                const current = c.id === tile.columnId;
                const count = (groups.get(c.id) ?? []).length;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      className={cls('move-column', current && 'is-current')}
                      aria-current={current ? 'true' : undefined}
                      data-column-id={c.id}
                      onClick={() => setSelected(c.id)}
                    >
                      <span className="move-column-name">{c.name}</span>
                      {current && <span className="tag">Current</span>}
                      <span className="move-column-count">{count}</span>
                      <ChevronRight size={16} aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </Modal>
  );
}

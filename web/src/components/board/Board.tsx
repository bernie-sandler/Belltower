import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type Announcements,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import type { BoardResponse, CardTile } from '@tt/shared';
import { Archive, ArrowRightLeft, ExternalLink, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { completionBlocked, sortedColumns, useBoard } from '../../api/board';
import { useArchiveCard } from '../../api/cardParts';
import { useDeleteCard, useCompleteCard,
  useMoveCard, useMoveCards, useRestoreCard } from '../../api/cards';
import { errorMessage } from '../../api/errors';
import { cls } from '../../lib/cls';
import { useShortcut } from '../../lib/keyboard';
import { useOpenCard } from '../../lib/navigation';
import { useNow } from '../../lib/time';
import { useCollapsedGroups } from '../../lib/groups';
import { toast } from '../../lib/toast';
import { scrollBehavior, useIsMobile } from '../../lib/useMediaQuery';
import { MoveToSheet } from '../card/MoveToSheet';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { Menu } from '../common/Menu';
import { ErrorScreen, LoadingScreen } from '../common/Status';
import { useShell } from '../shell/ShellContext';
import { AddColumn } from './AddColumn';
import { Column, GroupHeaderView } from './Column';
import { ColumnPills } from './ColumnPills';
import { FilterBar, matchesFilter, useBoardFilter } from './FilterBar';
import {
  autoScroll,
  collisionDetection,
  dropAnimation,
  keyboardCodes,
  keyboardCoordinates,
  measuring,
  parseDndId,
  parseGroupDndId,
} from './dnd';
import { TileView } from './Tile';
import { findColumn, useBoardDnd } from './useBoardDnd';

// Stable empty lists, so memoized columns don't re-render just because `?? []` made a new array.
const NO_IDS: number[] = [];
const NO_TILES: CardTile[] = [];

export function Board() {
  const { data: board, error, isPending, refetch } = useBoard();
  if (isPending) return <LoadingScreen label="Loading board…" />;
  if (!board) {
    return <ErrorScreen title="Couldn't load the board" message={errorMessage(error)} onRetry={() => void refetch()} />;
  }
  return <BoardView board={board} />;
}

function BoardView({ board }: { board: BoardResponse }) {
  const shell = useShell();
  const now = useNow();
  const navigateToCard = useOpenCard();
  // useOpenCard's function changes on every navigation; columns and tiles get a stable one.
  const navigateRef = useRef(navigateToCard);
  useEffect(() => {
    navigateRef.current = navigateToCard;
  });
  const openCard = useCallback((id: number) => navigateRef.current(id), []);
  const isMobile = useIsMobile();
  const moveCard = useMoveCard();
  const moveCards = useMoveCards();
  const completeCard = useCompleteCard();
  const deleteCard = useDeleteCard();
  const undelete = useRestoreCard('undelete');
  const archive = useArchiveCard();
  const unarchive = useRestoreCard('restore');

  const columns = useMemo(() => sortedColumns(board.columns), [board.columns]);
  const tilesById = useMemo(() => new Map(board.cards.map((c) => [c.id, c] as const)), [board.cards]);
  const labelsById = useMemo(() => new Map(board.labels.map((l) => [l.id, l] as const)), [board.labels]);
  const { filter, setFilter, active: filtering } = useBoardFilter();
  const [collapsed, toggleGroup] = useCollapsedGroups();
  // What the board shows (and drags over): everything, or just the cards that pass the filter.
  const visibleBoard = useMemo(
    () =>
      filtering
        ? { ...board, cards: board.cards.filter((c) => c.id < 0 || matchesFilter(c, filter, labelsById, now)) }
        : board,
    [board, filtering, filter, labelsById, now],
  );
  // Cards still being created (temporary negative ids), shown dimmed at the bottom of their column.
  const pendingByColumn = useMemo(() => {
    const map = new Map<number, CardTile[]>();
    for (const c of board.cards) {
      if (c.id > 0) continue;
      const list = map.get(c.columnId);
      if (list) list.push(c);
      else map.set(c.columnId, [c]);
    }
    return map;
  }, [board.cards]);

  const dnd = useBoardDnd(visibleBoard, columns, (move, onSettled) => {
    const blocked = completionBlocked(board, move.cardId, move.toColumnId);
    if (blocked) {
      toast(blocked, { kind: 'warning' });
      onSettled();
      return;
    }
    const tile = board.cards.find((c) => c.id === move.cardId);
    const target = board.columns.find((c) => c.id === move.toColumnId);
    const offerTickets = tile?.kind === 'work' && tile.childOpen > 0 && target?.role === 'done' && tile.columnId !== target.id;
    const intoDone = target?.role === 'done' && tile !== undefined && tile.columnId !== target.id;
    moveCard.mutate(move, {
      onSettled,
      onSuccess: () => {
        if (intoDone && !offerTickets) {
          toast(`“${tile.title}” is done.`, {
            kind: 'success',
            action: { label: 'Add resolution', onClick: () => shell.openResolution(tile.id) },
          });
        }
        if (!offerTickets) return;
        const n = tile.childOpen;
        toast(`“${tile.title}” is done. ${n} ticket${n === 1 ? '' : 's'} still open.`, {
          kind: 'info',
          action: {
            label: `Complete ${n === 1 ? 'it' : `all ${n}`}`,
            onClick: () =>
              completeCard.mutate(
                { id: tile.id, includeChildren: true },
                {
                  onSuccess: (res) => toast(`Completed ${res.completed.length} ticket${res.completed.length === 1 ? '' : 's'}`, { kind: 'success' }),
                  onError: (err) => toast(errorMessage(err), { kind: 'warning' }),
                },
              ),
          },
        });
      },
    });
  }, (move, onSettled) => {
    // A folder: all its tickets or none. The server moves them in one transaction; this just saves
    // the round trip when one blocked ticket is already known to keep the folder out of Done.
    const blocked = move.cardIds.map((id) => completionBlocked(board, id, move.toColumnId)).find((m) => m !== null);
    if (blocked) {
      toast(blocked, { kind: 'warning' });
      onSettled();
      return;
    }
    const target = board.columns.find((c) => c.id === move.toColumnId);
    const intoDone = target?.role === 'done' && board.cards.some((c) => move.cardIds.includes(c.id) && c.columnId !== target.id);
    const n = move.cardIds.length;
    moveCards.mutate(move, {
      onSettled,
      onSuccess: () => {
        if (intoDone) toast(`${n} ticket${n === 1 ? ' is' : 's are'} done.`, { kind: 'success' });
      },
    });
  });

  const [composerColumn, setComposerColumn] = useState<number | null>(null);
  const [addingColumn, setAddingColumn] = useState(false);
  const [tileMenu, setTileMenu] = useState<{ cardId: number; anchor: HTMLElement } | null>(null);
  const [moveTarget, setMoveTarget] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const boardRef = useRef<HTMLDivElement>(null);
  const columnEls = useRef(new Map<number, HTMLElement>());
  const registerElement = useCallback((id: number, el: HTMLElement | null) => {
    if (el) columnEls.current.set(id, el);
    else columnEls.current.delete(id);
  }, []);

  // ---- scrolling helpers ----

  const scrollToColumn = useCallback(
    (id: number) => {
      const el = columnEls.current.get(id);
      const scroller = boardRef.current;
      if (!el || !scroller) return;
      if (isMobile) {
        const pad = parseFloat(getComputedStyle(scroller).paddingLeft) || 0;
        scroller.scrollTo({ left: el.offsetLeft - pad, behavior: scrollBehavior() });
      } else {
        el.scrollIntoView({ behavior: scrollBehavior(), inline: 'nearest', block: 'nearest' });
      }
    },
    [isMobile],
  );

  const scrollToEnd = useCallback(() => {
    // Wait a frame so a just-added column is laid out.
    window.requestAnimationFrame(() => {
      const scroller = boardRef.current;
      scroller?.scrollTo({ left: scroller.scrollWidth, behavior: scrollBehavior() });
    });
  }, []);

  // Highlight the column that is mostly in view (phone pill bar).
  const scrollFrame = useRef(0);
  const onScroll = useCallback(() => {
    if (scrollFrame.current) return;
    scrollFrame.current = window.requestAnimationFrame(() => {
      scrollFrame.current = 0;
      const scroller = boardRef.current;
      if (!scroller) return;
      const start = scroller.scrollLeft;
      const end = start + scroller.clientWidth;
      let best = 0;
      let bestVisible = -1;
      columns.forEach((col, i) => {
        const el = columnEls.current.get(col.id);
        if (!el) return;
        const visible = Math.min(el.offsetLeft + el.offsetWidth, end) - Math.max(el.offsetLeft, start);
        if (visible > bestVisible + 1) {
          best = i;
          bestVisible = visible;
        }
      });
      setActiveIndex(best);
    });
  }, [columns]);

  useEffect(() => () => window.cancelAnimationFrame(scrollFrame.current), []);

  // ---- composer / add column ----

  const openComposer = useCallback((columnId: number) => {
    setAddingColumn(false);
    setComposerColumn(columnId);
  }, []);
  const closeComposer = useCallback(() => setComposerColumn(null), []);

  // 'n' → new card in the Triage column.
  useShortcut('n', () => {
    const triage = columns.find((c) => c.role === 'triage') ?? columns[0];
    if (!triage) return;
    openComposer(triage.id);
    scrollToColumn(triage.id);
  });

  // "Add column" from the top bar menu.
  const lastAddRequest = useRef(shell.addColumnRequest);
  useEffect(() => {
    if (shell.addColumnRequest === lastAddRequest.current) return;
    lastAddRequest.current = shell.addColumnRequest;
    setComposerColumn(null);
    setAddingColumn(true);
    scrollToEnd();
  }, [shell.addColumnRequest, scrollToEnd]);

  // ---- tile actions ----

  const onTileMenu = useCallback((cardId: number, anchor: HTMLElement) => setTileMenu({ cardId, anchor }), []);

  function confirmDelete(id: number) {
    deleteCard.mutate(id, {
      onSuccess: () => {
        setDeleteTarget(null);
        toast('Card moved to Trash', {
          kind: 'success',
          action: { label: 'Undo', onClick: () => undelete.mutate(id) },
        });
      },
    });
  }

  // ---- drag and drop ----

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinates, keyboardCodes }),
  );

  // Screen reader announcements in words (card titles and column names, not ids).
  const latest = useRef({ tilesById, columns, items: dnd.items });
  useEffect(() => {
    latest.current = { tilesById, columns, items: dnd.items };
  });
  const announcements = useMemo<Announcements>(() => {
    const cardName = (id: UniqueIdentifier) => {
      const g = parseGroupDndId(id);
      if (g) return `folder “${latest.current.tilesById.get(g.parentId)?.title ?? 'work card'}”`;
      const p = parseDndId(id);
      return p ? `“${latest.current.tilesById.get(p.id)?.title ?? 'card'}”` : 'card';
    };
    const place = (id: UniqueIdentifier | undefined) => {
      const p = id === undefined ? null : parseDndId(id);
      if (!p) return 'outside the board';
      const colId = p.kind === 'col' ? p.id : findColumn(latest.current.items, p.id);
      const name = latest.current.columns.find((c) => c.id === colId)?.name;
      return name ? `column ${name}` : 'the board';
    };
    return {
      onDragStart: ({ active }) => `Picked up ${cardName(active.id)}.`,
      onDragOver: ({ active, over }) => `${cardName(active.id)} is over ${place(over?.id)}.`,
      onDragEnd: ({ active, over }) =>
        over ? `${cardName(active.id)} was dropped in ${place(over.id)}.` : `${cardName(active.id)} was put back.`,
      onDragCancel: ({ active }) => `Moving ${cardName(active.id)} was cancelled.`,
    };
  }, []);

  const activeTile = dnd.activeId !== null ? tilesById.get(dnd.activeId) : undefined;
  const counts = columns.map(
    (c) => (dnd.items.get(c.id)?.length ?? 0) + (pendingByColumn.get(c.id)?.length ?? 0),
  );
  const menuTile = tileMenu ? tilesById.get(tileMenu.cardId) : undefined;
  const menuTileDone = menuTile ? columns.find((c) => c.id === menuTile.columnId)?.role === 'done' : false;
  const deleteTile = deleteTarget !== null ? tilesById.get(deleteTarget) : undefined;

  return (
    <div className="board-page">
      <FilterBar
        labels={board.labels}
        filter={filter}
        setFilter={setFilter}
        active={filtering}
        shown={visibleBoard.cards.filter((c) => c.id > 0).length}
        total={board.cards.filter((c) => c.id > 0).length}
      />
      {isMobile && columns.length > 0 && (
        <ColumnPills
          columns={columns}
          counts={counts}
          activeIndex={Math.min(activeIndex, columns.length - 1)}
          onSelect={(i) => {
            const col = columns[i];
            if (col) scrollToColumn(col.id);
          }}
        />
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        measuring={measuring}
        autoScroll={autoScroll}
        accessibility={{ announcements }}
        {...dnd.handlers}
      >
        <div ref={boardRef} className={cls('board', dnd.isDragging && 'is-dragging')} onScroll={onScroll}>
          {columns.map((col, i) => (
            <Column
              key={col.id}
              column={col}
              columns={columns}
              index={i}
              cardIds={dnd.items.get(col.id) ?? NO_IDS}
              pendingTiles={pendingByColumn.get(col.id) ?? NO_TILES}
              tilesById={tilesById}
              collapsed={collapsed}
              onToggleGroup={toggleGroup}
              labelsById={labelsById}
              now={now}
              composerOpen={composerColumn === col.id}
              onOpenComposer={openComposer}
              onCloseComposer={closeComposer}
              onOpenCard={openCard}
              onTileMenu={onTileMenu}
              menuCardId={tileMenu?.cardId ?? null}
              registerElement={registerElement}
            />
          ))}
          <AddColumn
            open={addingColumn}
            onOpen={() => {
              setComposerColumn(null);
              setAddingColumn(true);
            }}
            onClose={() => setAddingColumn(false)}
            onAdded={scrollToEnd}
          />
        </div>
        {createPortal(
          <DragOverlay dropAnimation={dropAnimation}>
            {activeTile ? (
              <TileView tile={activeTile} labelsById={labelsById} now={now} overlay />
            ) : dnd.activeGroup ? (
              <GroupHeaderView parent={tilesById.get(dnd.activeGroup.parentId)} count={dnd.activeGroup.count} overlay />
            ) : null}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>

      {tileMenu && menuTile && (
        <Menu
          anchor={tileMenu.anchor}
          onClose={() => setTileMenu(null)}
          label={`Actions for “${menuTile.title}”`}
          items={[
            { key: 'open', label: 'Open', icon: <ExternalLink size={16} />, onSelect: () => openCard(menuTile.id) },
            { key: 'move', label: 'Move to…', icon: <ArrowRightLeft size={16} />, onSelect: () => setMoveTarget(menuTile.id) },
            ...(menuTileDone
              ? [
                  {
                    key: 'archive',
                    label: 'Archive',
                    icon: <Archive size={16} />,
                    onSelect: () => {
                      const id = menuTile.id;
                      archive.mutate(id, {
                        onSuccess: () =>
                          toast('Card archived', { kind: 'success', action: { label: 'Undo', onClick: () => unarchive.mutate(id) } }),
                      });
                    },
                  },
                ]
              : []),
            'separator',
            { key: 'delete', label: 'Delete…', icon: <Trash2 size={16} />, danger: true, onSelect: () => setDeleteTarget(menuTile.id) },
          ]}
        />
      )}

      {moveTarget !== null && <MoveToSheet cardId={moveTarget} onClose={() => setMoveTarget(null)} />}

      {deleteTarget !== null && (
        <ConfirmDialog
          title="Delete card?"
          message={
            <>
              {deleteTile ? `“${deleteTile.title}”` : 'This card'} moves to Trash. Its history is kept and it can be
              restored.
            </>
          }
          danger
          confirmLabel="Delete card"
          busy={deleteCard.isPending}
          onConfirm={() => confirmDelete(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}

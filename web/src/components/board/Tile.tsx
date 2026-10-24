import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { PRIORITY_CODES, PRIORITY_LABELS, SEVERITY_CODES, SEVERITY_LABELS, type CardTile, type Label } from '@tt/shared';
import { Ban, Clock, Ellipsis, Link2, Paperclip, SquareCheckBig } from 'lucide-react';
import { memo, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import { cls } from '../../lib/cls';
import { isDragging as isBoardDragging, justDropped } from '../../lib/dragging';
import { dueStatus, formatDue, type DueStatus } from '../../lib/time';
import { LabelChip } from '../labels/LabelChip';
import { cardDndId } from './dnd';
import { TicketTitle } from '../common/TicketTitle';

const DUE_TITLES: Record<DueStatus, string> = {
  overdue: 'Overdue',
  soon: 'Due within 48 hours',
  upcoming: 'Due date',
};

interface TileViewProps {
  tile: CardTile;
  labelsById: Map<number, Label>;
  now: number;
  /** Unsaved optimistic tile (just created): dimmed, not interactive. */
  pending?: boolean;
  /** The floating copy under the pointer while dragging. */
  overlay?: boolean;
  /** A ⋯ button sits over the tile's top-right corner: keep text clear of it. */
  hasMenu?: boolean;
}

/** Presentational tile: labels, title, badges. Used on the board and in the drag overlay. */
export function TileView({ tile, labelsById, now, pending, overlay, hasMenu }: TileViewProps) {
  const labels = tile.labelIds
    .map((id) => labelsById.get(id))
    .filter((l): l is Label => l !== undefined)
    .sort((a, b) => a.position - b.position);
  const due = dueStatus(tile, now);
  const blocked = tile.blockedBy > 0 && !tile.completedAt;
  const hasFooter =
    blocked ||
    due !== null ||
    tile.attachmentCount > 0 ||
    tile.linkCount > 0 ||
    tile.checklistTotal > 0 ||
    tile.priority !== null ||
    tile.severity !== null;

  return (
    <div
      className={cls(
        'tile',
        tile.priority && `prio-${tile.priority}`,
        pending && 'is-pending',
        overlay && 'is-overlay',
        hasMenu && 'has-menu',
      )}
    >
      {tile.priority && <span className="tile-prio" aria-hidden />}
      {labels.length > 0 && (
        <div className="tile-labels">
          {labels.map((l) => (
            <LabelChip key={l.id} label={l} size="sm" />
          ))}
        </div>
      )}
      <div className="tile-title">
        <TicketTitle ticketNo={tile.ticketNo}>{tile.title}</TicketTitle>
      </div>
      {hasFooter && (
        <div className="tile-footer">
          {tile.priority && (
            <span className={cls('badge level-badge', `prio-badge-${tile.priority}`)} title={`Priority ${PRIORITY_LABELS[tile.priority]}`}>
              <span className="visually-hidden">Priority </span>
              {PRIORITY_CODES[tile.priority]}
            </span>
          )}
          {tile.severity && (
            <span className={cls('badge level-badge', `sev-badge-${tile.severity}`)} title={`Severity ${SEVERITY_LABELS[tile.severity]}`}>
              <span className="visually-hidden">Severity </span>
              {SEVERITY_CODES[tile.severity]}
            </span>
          )}
          {blocked && (
            <span className="badge blocked-badge" title={`Blocked by ${tile.blockedBy} open card${tile.blockedBy === 1 ? '' : 's'}`}>
              <Ban size={12} aria-hidden />
              Blocked
              <span className="visually-hidden"> by {tile.blockedBy} open card{tile.blockedBy === 1 ? '' : 's'}</span>
            </span>
          )}
          {due !== null && tile.dueDate && (
            <span className={cls('badge', 'due-badge', `due-${due}`)} title={DUE_TITLES[due]}>
              <Clock size={12} aria-hidden />
              <span className="visually-hidden">{DUE_TITLES[due]}: </span>
              {formatDue(tile.dueDate, tile.dueTime, { relative: true, now })}
            </span>
          )}
          {tile.attachmentCount > 0 && (
            <span className="badge" title="Attachments">
              <Paperclip size={12} aria-hidden />
              <span className="visually-hidden">Attachments: </span>
              {tile.attachmentCount}
            </span>
          )}
          {tile.linkCount > 0 && (
            <span className="badge" title="Linked cards">
              <Link2 size={12} aria-hidden />
              <span className="visually-hidden">Linked cards: </span>
              {tile.linkCount}
            </span>
          )}
          {tile.checklistTotal > 0 && (
            <span
              className={cls('badge', tile.checklistDone === tile.checklistTotal && 'is-complete')}
              title="Checklist items"
            >
              <SquareCheckBig size={12} aria-hidden />
              <span className="visually-hidden">Checklist: </span>
              {tile.checklistDone}/{tile.checklistTotal}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

interface SortableTileProps {
  tile: CardTile;
  labelsById: Map<number, Label>;
  now: number;
  menuOpen: boolean;
  onOpen: (id: number) => void;
  onMenu: (id: number, anchor: HTMLElement) => void;
}

// The "⋯" button must not start a drag or open the card.
const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

/**
 * A draggable tile: tap/click opens the card, long-press (touch) or drag (mouse) moves it.
 * The drag/open target (dnd-kit's activator, role=button) and the ⋯ button are siblings, so the
 * menu button isn't nested inside another button and screen readers (VoiceOver) can reach it.
 */
export const SortableTile = memo(function SortableTile({
  tile,
  labelsById,
  now,
  menuOpen,
  onOpen,
  onMenu,
}: SortableTileProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: cardDndId(tile.id),
    data: { type: 'card', cardId: tile.id },
    transition: { duration: 150, easing: 'ease' },
  });

  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    listeners?.onKeyDown?.(e); // Space picks the tile up (keyboard drag)
    // During a keyboard drag Enter drops the card (dnd-kit's document listener runs after this
    // one), so it must not also open it.
    if (isBoardDragging()) return;
    if (e.key === 'Enter' && !e.defaultPrevented && e.target === e.currentTarget) {
      e.preventDefault();
      onOpen(tile.id);
    }
  };

  const menuButton = (
    <button
      type="button"
      className="tile-menu-btn"
      aria-label={`Actions for “${tile.title}”`}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      onMouseDown={stop}
      onTouchStart={stop}
      onPointerDown={stop}
      onKeyDown={stop}
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        onMenu(tile.id, e.currentTarget);
      }}
    >
      <Ellipsis size={16} aria-hidden />
    </button>
  );

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cls('tile-slot', isDragging && 'is-placeholder')}
      data-card-id={tile.id}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        ref={setActivatorNodeRef}
        className="tile-activator"
        {...attributes}
        {...listeners}
        aria-roledescription="card"
        onKeyDown={onKeyDown}
        onClick={() => {
          if (!justDropped()) onOpen(tile.id);
        }}
      >
        <TileView tile={tile} labelsById={labelsById} now={now} hasMenu />
      </div>
      {menuButton}
    </div>
  );
});

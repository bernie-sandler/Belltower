// Card detail, shown at /cards/:id over the board: a modal on desktop, a full-screen sheet on
// phones (same markup, CSS decides). Title, labels, priority/due/completion, Markdown description,
// checklists, attachments (picker, drop, paste), linked cards, and the activity + work log.

import type { CardDetail as CardDetailType, Label } from '@tt/shared';
import {
  Archive,
  ArchiveRestore,
  ArrowRightLeft,
  CircleCheck,
  Link2,
  ListChecks,
  NotebookPen,
  Paperclip,
  Plus,
  Tag,
  Trash2,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { sortedColumns, useBoard } from '../../api/board';
import { useArchiveCard } from '../../api/cardParts';
import { useCard, useDeleteCard, useMoveCard, useRestoreCard } from '../../api/cards';
import { isApiError } from '../../api/client';
import { errorMessage } from '../../api/errors';
import { sortedLabels } from '../../api/labels';
import { cls } from '../../lib/cls';
import { clearDraft } from '../../lib/drafts';
import { formatDateTime, useNow } from '../../lib/time';
import { toast } from '../../lib/toast';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { Modal } from '../common/Modal';
import { Spinner } from '../common/Status';
import { LabelChip } from '../labels/LabelChip';
import { useShell } from '../shell/ShellContext';
import { ActivityList } from './ActivityList';
import { Attachments, useAttachmentUploader, useFileDrop, usePasteToAttach } from './Attachments';
import { CardFields } from './CardFields';
import { Checklists } from './Checklists';
import { Links } from './Links';
import { DescriptionEditor, descriptionDraftKey } from './DescriptionEditor';
import { LabelPicker } from './LabelPicker';
import { MoveToSheet } from './MoveToSheet';
import { TitleEditor } from './TitleEditor';

interface Props {
  cardId: number;
  onClose: () => void;
}

export function CardDetailModal({ cardId, onClose }: Props) {
  const { data: card, error, isPending } = useCard(cardId);
  const { data: board } = useBoard();
  const titleId = useId();
  const dirty = useRef({ title: false, description: false });
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // Unsaved title/description edits prompt before the card closes (X, Esc, backdrop).
  const requestClose = useCallback(() => {
    if (dirty.current.title || dirty.current.description) setConfirmDiscard(true);
    else onClose();
  }, [onClose]);

  const onTitleDirty = useCallback((d: boolean) => {
    dirty.current.title = d;
  }, []);
  const onDescriptionDirty = useCallback((d: boolean) => {
    dirty.current.description = d;
  }, []);

  const tile = board?.cards.find((c) => c.id === cardId);
  const notFound = cardId <= 0 || isApiError(error, 'not_found');

  let content;
  if (card) {
    content = (
      <CardDetailBody
        card={card}
        labels={board?.labels ?? []}
        columnName={board?.columns.find((c) => c.id === card.columnId)?.name}
        titleId={titleId}
        onClose={onClose}
        requestClose={requestClose}
        onTitleDirty={onTitleDirty}
        onDescriptionDirty={onDescriptionDirty}
      />
    );
  } else if (isPending && cardId > 0) {
    content = (
      <div className="card-detail">
        <header className="card-header">
          <div className="card-header-main">
            <h2 id={titleId} className="card-title">
              {tile?.title ?? 'Loading card…'}
            </h2>
          </div>
          <CloseButton onClick={onClose} />
        </header>
        <div className="card-loading">
          <Spinner label="Loading card…" />
        </div>
      </div>
    );
  } else {
    content = (
      <div className="card-detail">
        <header className="card-header">
          <div className="card-header-main">
            <h2 id={titleId} className="card-title">
              {notFound ? 'Card not found' : "Couldn't load this card"}
            </h2>
          </div>
          <CloseButton onClick={onClose} />
        </header>
        <p className="card-error">
          {notFound ? 'It may have been removed, or the link is wrong.' : errorMessage(error)}
        </p>
      </div>
    );
  }

  return (
    <Modal variant="card" size="lg" history={false} onClose={requestClose} labelledBy={titleId} initialFocus="panel" className="card-modal">
      {content}
      {confirmDiscard && (
        <ConfirmDialog
          title="Discard unsaved changes?"
          message="Your edits to this card haven't been saved."
          danger
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={() => {
            clearDraft(descriptionDraftKey(cardId));
            dirty.current = { title: false, description: false };
            setConfirmDiscard(false);
            onClose();
          }}
        />
      )}
    </Modal>
  );
}

function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="icon-btn card-close" aria-label="Close card" onClick={onClick}>
      <X size={20} aria-hidden />
    </button>
  );
}

interface BodyProps {
  card: CardDetailType;
  labels: Label[];
  columnName: string | undefined;
  titleId: string;
  onClose: () => void;
  requestClose: () => void;
  onTitleDirty: (d: boolean) => void;
  onDescriptionDirty: (d: boolean) => void;
}

function CardDetailBody({
  card,
  labels,
  columnName,
  titleId,
  onClose,
  requestClose,
  onTitleDirty,
  onDescriptionDirty,
}: BodyProps) {
  const shell = useShell();
  const now = useNow();
  const { data: board } = useBoard();
  const deleteCard = useDeleteCard();
  const undelete = useRestoreCard('undelete');
  const unarchive = useRestoreCard('restore');
  const archive = useArchiveCard();
  const [labelAnchor, setLabelAnchor] = useState<HTMLElement | null>(null);
  const [moving, setMoving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Bumped by the sidebar buttons to open the matching section's "add" UI.
  const [checklistRequest, setChecklistRequest] = useState(0);
  const [linkRequest, setLinkRequest] = useState(0);
  const [logRequest, setLogRequest] = useState(0);

  const allLabels = useMemo(() => sortedLabels(labels), [labels]);
  const cardLabels = allLabels.filter((l) => card.labelIds.includes(l.id));
  const deleted = card.deletedAt !== null;
  const archived = card.archivedAt !== null;
  const onBoard = !deleted && !archived;
  const doneColumn = board ? sortedColumns(board.columns).find((c) => c.role === 'done') : undefined;
  const uploader = useAttachmentUploader(card.id, !deleted);
  usePasteToAttach(uploader.upload, !deleted);
  const drop = useFileDrop(uploader.upload, !deleted);

  function doDelete() {
    deleteCard.mutate(card.id, {
      onSuccess: () => {
        onClose();
        const id = card.id;
        toast('Card moved to Trash', {
          kind: 'success',
          action: { label: 'Undo', onClick: () => undelete.mutate(id) },
        });
      },
    });
  }

  return (
    <div className={cls('card-detail', drop.over && 'is-drop-target')} {...drop.props}>
      {drop.over && (
        <div className="drop-overlay" aria-hidden>
          <Upload size={28} /> Drop files to attach
        </div>
      )}
      {uploader.input}
      <header className="card-header">
        <div className="card-header-main">
          <TitleEditor card={card} titleId={titleId} readOnly={deleted} onDirtyChange={onTitleDirty} />
          <p className="card-location">
            in column{' '}
            {onBoard ? (
              <button type="button" className="link-btn" onClick={() => setMoving(true)} title="Move to another column">
                {columnName ?? '…'}
              </button>
            ) : (
              <strong>{columnName ?? '…'}</strong>
            )}
            {card.completedAt && (
              <span className="tag tag-success">
                <CircleCheck size={12} aria-hidden /> Done
              </span>
            )}
          </p>
        </div>
        {!deleted && (
          <button type="button" className="btn btn-sm card-log-btn" onClick={() => setLogRequest((n) => n + 1)}>
            <NotebookPen size={16} aria-hidden /> <span className="card-log-label">Log work</span>
          </button>
        )}
        <CloseButton onClick={requestClose} />
      </header>

      {deleted && (
        <div className="banner banner-danger" role="status">
          <span>This card is in Trash.</span>
          <button type="button" className="btn btn-sm" onClick={() => undelete.mutate(card.id)} disabled={undelete.isPending}>
            <Undo2 size={14} aria-hidden /> Restore
          </button>
        </div>
      )}
      {archived && !deleted && (
        <div className="banner" role="status">
          <span>This card is archived.</span>
          <button type="button" className="btn btn-sm" onClick={() => unarchive.mutate(card.id)} disabled={unarchive.isPending}>
            <ArchiveRestore size={14} aria-hidden /> Restore to board
          </button>
        </div>
      )}

      <div className="card-body">
        <div className="card-main">
          <section className="card-section" aria-labelledby="card-labels-heading">
            <h3 id="card-labels-heading" className="card-section-title">
              <Tag size={16} aria-hidden /> Labels
            </h3>
            <div className="card-labels">
              {cardLabels.map((l) => (
                <LabelChip key={l.id} label={l} />
              ))}
              {!deleted && (
                <button
                  type="button"
                  className="btn btn-sm card-label-add"
                  aria-label={cardLabels.length ? 'Edit labels' : 'Add labels'}
                  aria-haspopup="dialog"
                  aria-expanded={labelAnchor !== null}
                  onClick={(e) => setLabelAnchor(labelAnchor ? null : e.currentTarget)}
                >
                  <Plus size={14} aria-hidden /> {cardLabels.length ? '' : 'Add'}
                </button>
              )}
            </div>
          </section>

          <CardFields card={card} readOnly={deleted} />

          <DescriptionEditor card={card} readOnly={deleted} onDirtyChange={onDescriptionDirty} />
          <Checklists card={card} readOnly={deleted} addRequest={checklistRequest} />
          <Attachments card={card} readOnly={deleted} uploader={uploader} />
          <Links card={card} readOnly={deleted} addRequest={linkRequest} />
          <ActivityList cardId={card.id} readOnly={deleted} composeRequest={logRequest} />
          <p className="card-footnote muted">
            Created {formatDateTime(card.createdAt, now)}
            {card.updatedAt !== card.createdAt && <> · Updated {formatDateTime(card.updatedAt, now)}</>}
          </p>
        </div>

        <aside className="card-sidebar" aria-label="Card actions">
          {!deleted && (
            <>
              <p className="card-sidebar-title">Add to card</p>
              <button type="button" className="btn btn-block card-action" onClick={() => setLogRequest((n) => n + 1)}>
                <NotebookPen size={16} aria-hidden /> Log work
              </button>
              <button type="button" className="btn btn-block card-action" onClick={() => setChecklistRequest((n) => n + 1)}>
                <ListChecks size={16} aria-hidden /> Checklist
              </button>
              <button type="button" className="btn btn-block card-action" onClick={uploader.pick}>
                <Paperclip size={16} aria-hidden /> Attachment
              </button>
              <button type="button" className="btn btn-block card-action" onClick={() => setLinkRequest((n) => n + 1)}>
                <Link2 size={16} aria-hidden /> Link card
              </button>
              <p className="card-sidebar-title">Actions</p>
            </>
          )}
          {onBoard && (
            <>
              <button type="button" className="btn btn-block card-action" onClick={() => setMoving(true)}>
                <ArrowRightLeft size={16} aria-hidden /> Move to…
              </button>
              {doneColumn && card.columnId !== doneColumn.id && <MarkDoneButton cardId={card.id} />}
              {doneColumn && card.columnId === doneColumn.id && (
                <button
                  type="button"
                  className="btn btn-block card-action"
                  disabled={archive.isPending}
                  onClick={() =>
                    archive.mutate(card.id, {
                      onSuccess: () => {
                        onClose();
                        const id = card.id;
                        toast('Card archived', { kind: 'success', action: { label: 'Undo', onClick: () => unarchive.mutate(id) } });
                      },
                    })
                  }
                >
                  <Archive size={16} aria-hidden /> Archive
                </button>
              )}
            </>
          )}
          {!deleted && (
            <button
              type="button"
              className="btn btn-block card-action card-action-danger"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={16} aria-hidden /> Delete
            </button>
          )}
        </aside>
      </div>

      {labelAnchor && (
        <LabelPicker
          card={card}
          labels={allLabels}
          anchor={labelAnchor}
          onClose={() => setLabelAnchor(null)}
          onManage={shell.openLabels}
        />
      )}
      {moving && <MoveToSheet cardId={card.id} onClose={() => setMoving(false)} />}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete card?"
          message="The card moves to Trash. Its history is kept and it can be restored."
          danger
          confirmLabel="Delete card"
          busy={deleteCard.isPending}
          onConfirm={doDelete}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}

/** One tap: move to the top of the Done column. */
function MarkDoneButton({ cardId }: { cardId: number }) {
  const { data: board } = useBoard();
  const moveCard = useMoveCard();
  const done = board ? sortedColumns(board.columns).find((c) => c.role === 'done') : undefined;
  if (!done) return null;
  return (
    <button
      type="button"
      className="btn btn-block card-action"
      onClick={() => {
        moveCard.mutate({ cardId, toColumnId: done.id, afterCardId: null });
        toast(`Moved to ${done.name}`, { kind: 'success', durationMs: 2500 });
      }}
    >
      <CircleCheck size={16} aria-hidden /> Mark done
    </button>
  );
}

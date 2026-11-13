// Archive (/archive) and Trash (/trash): searchable lists of cards that aren't on the board.
// Opening a card shows it over this page; Restore puts it back on the board.

import type { CardSummary } from '@tt/shared';
import { Archive, ArchiveRestore, Search, Trash2, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useBoard } from '../../api/board';
import { useArchiveAllDone, useCardList } from '../../api/cardParts';
import { useRestoreCard } from '../../api/cards';
import { errorMessage } from '../../api/errors';
import { useOpenCard } from '../../lib/navigation';
import { formatDateTime, useNow } from '../../lib/time';
import { toast } from '../../lib/toast';
import { useQueryClient } from '@tanstack/react-query';
import { qk } from '../../api/keys';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { Spinner } from '../common/Status';
import { LabelChip } from '../labels/LabelChip';
import { TicketTitle } from '../common/TicketTitle';
import { useIsRestricted } from '../../api/me';

type Kind = 'archived' | 'trashed';

const COPY: Record<Kind, { title: string; empty: string; icon: typeof Archive }> = {
  archived: { title: 'Archive', empty: 'No archived cards.', icon: Archive },
  trashed: { title: 'Trash', empty: 'The Trash is empty.', icon: Trash2 },
};

export function CardListPage({ kind }: { kind: Kind }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q), 200);
    return () => window.clearTimeout(t);
  }, [q]);
  const list = useCardList(kind, debounced);
  const { data: board } = useBoard();
  const labelsById = useMemo(() => new Map((board?.labels ?? []).map((l) => [l.id, l] as const)), [board?.labels]);
  const openCard = useOpenCard();
  const now = useNow();
  const qc = useQueryClient();
  const restore = useRestoreCard(kind === 'archived' ? 'restore' : 'undelete');
  const archiveAll = useArchiveAllDone();
  const restricted = useIsRestricted();
  const [confirmArchiveAll, setConfirmArchiveAll] = useState(false);
  const doneColumn = board?.columns.find((c) => c.role === 'done');
  const doneCount = doneColumn ? (board?.cards.filter((c) => c.columnId === doneColumn.id).length ?? 0) : 0;
  const Icon = COPY[kind].icon;

  function doRestore(c: CardSummary) {
    restore.mutate(c.id, {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: qk.cardLists });
        toast(`Restored “${c.title}” to ${c.columnName}`, { kind: 'success' });
      },
    });
  }

  return (
    <div className="list-page">
      <header className="list-page-header">
        <h2 className="list-page-title">
          <Icon size={20} aria-hidden /> {COPY[kind].title}
        </h2>
        {kind === 'archived' && doneCount > 0 && !restricted && (
          <button type="button" className="btn" onClick={() => setConfirmArchiveAll(true)}>
            <Archive size={16} aria-hidden /> Archive all in {doneColumn?.name ?? 'Done'} ({doneCount})
          </button>
        )}
      </header>
      {kind === 'trashed' && (
        <p className="muted">Deleted cards keep their full history here and can be restored. Nothing is ever purged.</p>
      )}
      <label className="search-field">
        <Search size={16} aria-hidden />
        <input
          className="input"
          type="search"
          placeholder={`Search ${COPY[kind].title.toLowerCase()} by title or #id`}
          aria-label="Search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </label>

      {list.isPending && <Spinner label="Loading…" />}
      {list.error && <p className="form-error">{errorMessage(list.error)}</p>}
      {list.data && list.data.length === 0 && <p className="muted">{debounced ? 'No matches.' : COPY[kind].empty}</p>}
      {list.data && list.data.length > 0 && (
        <ul className="card-list">
          {list.data.map((c) => (
            <li key={c.id} className="card-list-row">
              <button type="button" className="card-list-main" onClick={() => openCard(c.id)}>
                {c.labelIds.length > 0 && (
                  <span className="tile-labels">
                    {c.labelIds.map((id) => {
                      const l = labelsById.get(id);
                      return l ? <LabelChip key={id} label={l} size="sm" /> : null;
                    })}
                  </span>
                )}
                <span className="card-list-title">
                  <TicketTitle ticketNo={c.ticketNo}>{c.title}</TicketTitle>
                </span>
                <span className="muted small">
                  {c.columnName} ·{' '}
                  {kind === 'archived' ? `archived ${formatDateTime(c.archivedAt!, now)}` : `deleted ${formatDateTime(c.deletedAt!, now)}`}
                </span>
              </button>
              <button type="button" className="btn btn-sm" disabled={restore.isPending} onClick={() => doRestore(c)}>
                {kind === 'archived' ? <ArchiveRestore size={14} aria-hidden /> : <Undo2 size={14} aria-hidden />} Restore
              </button>
            </li>
          ))}
        </ul>
      )}

      {confirmArchiveAll && (
        <ConfirmDialog
          title={`Archive all ${doneCount} card${doneCount === 1 ? '' : 's'} in ${doneColumn?.name ?? 'Done'}?`}
          message="They leave the board but stay searchable, in the calendar, and here in the Archive."
          confirmLabel="Archive all"
          busy={archiveAll.isPending}
          onCancel={() => setConfirmArchiveAll(false)}
          onConfirm={() =>
            archiveAll.mutate(undefined, {
              onSuccess: (r) => {
                setConfirmArchiveAll(false);
                toast(`Archived ${r.archived} card${r.archived === 1 ? '' : 's'}`, { kind: 'success' });
              },
            })
          }
        />
      )}
    </div>
  );
}

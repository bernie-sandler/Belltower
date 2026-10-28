// Search for a card (by title or ticket number) and pick one. Used to link cards and to file
// tickets under work cards. `children` go above the search box (e.g. a link-type switch).

import type { CardKind, CardSummary } from '@tt/shared';
import { Search } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useCardList, type CardListStatus } from '../../api/cardParts';
import { errorMessage } from '../../api/errors';
import { Modal } from './Modal';
import { Spinner } from './Status';
import { TicketTitle } from './TicketTitle';

interface Props {
  title: string;
  /** Which cards to search: 'live' includes archived ones, 'board' only cards on the board. */
  status?: CardListStatus;
  kind?: CardKind;
  /** Cards never listed (e.g. the card itself). */
  exclude: number[];
  /** A reason a listed card can't be picked right now (shown after its column), or null. */
  unavailable?: (card: CardSummary) => string | null;
  busy?: boolean;
  empty?: string;
  onPick: (card: CardSummary) => void;
  onClose: () => void;
  children?: ReactNode;
}

export function CardPicker({ title, status = 'live', kind, exclude, unavailable, busy, empty, onPick, onClose, children }: Props) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q), 200);
    return () => window.clearTimeout(t);
  }, [q]);
  const { data, isPending, error } = useCardList(status, debounced, true, kind);
  const results = (data ?? []).filter((c) => !exclude.includes(c.id));

  return (
    <Modal title={title} variant="sheet" size="md" onClose={onClose}>
      <div className="modal-body link-picker">
        {children}
        <label className="search-field">
          <Search size={16} aria-hidden />
          <input
            className="input"
            type="search"
            placeholder="Search titles or ticket numbers"
            aria-label="Search cards"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoFocus
          />
        </label>
        {isPending && <Spinner label="Searching…" />}
        {error && <p className="form-error">{errorMessage(error)}</p>}
        <ul className="pick-list">
          {results.map((c) => {
            const reason = unavailable?.(c) ?? null;
            return (
              <li key={c.id}>
                <button type="button" className="pick-item" disabled={reason !== null || busy} onClick={() => onPick(c)}>
                  <span className="pick-title">
                    <TicketTitle ticketNo={c.ticketNo}>{c.title}</TicketTitle>
                  </span>
                  <span className="muted small">
                    {c.archivedAt ? 'Archived' : c.columnName}
                    {reason && ` · ${reason}`}
                  </span>
                </button>
              </li>
            );
          })}
          {data && results.length === 0 && <li className="muted pick-empty">{empty ?? 'No cards found.'}</li>}
        </ul>
      </div>
    </Modal>
  );
}

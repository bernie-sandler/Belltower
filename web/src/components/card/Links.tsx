// Linked cards, grouped as "Blocked by", "Blocks" and "Related". Each link shows on both cards.
// Clicking a linked card opens it (over the same background page).

import type { CardDetail, CardLink, LinkDirection } from '@tt/shared';
import { CircleCheck, Link2, Search, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useCardList, useLinkActions } from '../../api/cardParts';
import { errorMessage } from '../../api/errors';
import { useOpenCard } from '../../lib/navigation';
import { Modal } from '../common/Modal';
import { Spinner } from '../common/Status';

const GROUPS: { direction: LinkDirection; title: string }[] = [
  { direction: 'blocked_by', title: 'Blocked by' },
  { direction: 'blocks', title: 'Blocks' },
  { direction: 'relates', title: 'Related to' },
];

export function Links({
  card,
  readOnly,
  addRequest,
}: {
  card: CardDetail;
  readOnly: boolean;
  addRequest: number;
}) {
  const { unlink } = useLinkActions(card.id);
  const openCard = useOpenCard();
  const [picking, setPicking] = useState(false);
  const seen = useRef(addRequest);
  useEffect(() => {
    if (addRequest !== seen.current) {
      seen.current = addRequest;
      setPicking(true);
    }
  }, [addRequest]);

  return (
    <>
      {card.links.length > 0 && (
        <section className="card-section" aria-labelledby="card-links-heading">
          <div className="card-section-head">
            <h3 id="card-links-heading" className="card-section-title">
              <Link2 size={16} aria-hidden /> Linked cards
            </h3>
            {!readOnly && (
              <button type="button" className="btn btn-sm" onClick={() => setPicking(true)}>
                Add
              </button>
            )}
          </div>
          {GROUPS.map(({ direction, title }) => {
            const links = card.links.filter((l) => l.direction === direction);
            if (!links.length) return null;
            return (
              <div key={direction} className="link-group">
                <h4 className="link-group-title">{title}</h4>
                <ul className="link-list">
                  {links.map((l) => (
                    <LinkRow
                      key={l.id}
                      link={l}
                      readOnly={readOnly}
                      onOpen={() => openCard(l.card.id)}
                      onUnlink={() => unlink.mutate({ linkId: l.id, otherCardId: l.card.id })}
                    />
                  ))}
                </ul>
              </div>
            );
          })}
        </section>
      )}
      {picking && <LinkPicker card={card} onClose={() => setPicking(false)} />}
    </>
  );
}

function LinkRow({
  link,
  readOnly,
  onOpen,
  onUnlink,
}: {
  link: CardLink;
  readOnly: boolean;
  onOpen: () => void;
  onUnlink: () => void;
}) {
  const c = link.card;
  return (
    <li className="link-row">
      <button type="button" className="link-row-main" onClick={onOpen}>
        <span className="link-row-title">{c.title}</span>
        <span className="muted small">
          {c.archivedAt ? 'Archived' : c.columnName}
          {c.completedAt && (
            <>
              {' · '}
              <CircleCheck size={12} aria-hidden /> done
            </>
          )}
        </span>
      </button>
      {!readOnly && (
        <button type="button" className="icon-btn" aria-label={`Unlink “${c.title}”`} onClick={onUnlink}>
          <X size={16} aria-hidden />
        </button>
      )}
    </li>
  );
}

function LinkPicker({ card, onClose }: { card: CardDetail; onClose: () => void }) {
  const [direction, setDirection] = useState<LinkDirection>('relates');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const { link } = useLinkActions(card.id);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q), 200);
    return () => window.clearTimeout(t);
  }, [q]);
  const { data, isPending, error } = useCardList('live', debounced);

  const linked = new Set(card.links.filter((l) => l.direction === direction).map((l) => l.card.id));
  const results = (data ?? []).filter((c) => c.id !== card.id);

  return (
    <Modal title="Link a card" variant="sheet" size="md" onClose={onClose}>
      <div className="modal-body link-picker">
        <div className="segmented" role="radiogroup" aria-label="Link type">
          {(
            [
              ['relates', 'Related to'],
              ['blocks', 'Blocks'],
              ['blocked_by', 'Blocked by'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={direction === value}
              className="segmented-item"
              onClick={() => setDirection(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="muted small">
          {direction === 'blocks' && 'This card blocks the card you pick.'}
          {direction === 'blocked_by' && 'This card is waiting on the card you pick.'}
          {direction === 'relates' && 'The two cards are related.'}
        </p>
        <label className="search-field">
          <Search size={16} aria-hidden />
          <input
            className="input"
            type="search"
            placeholder="Search card titles or #id"
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
            const already = linked.has(c.id);
            return (
              <li key={c.id}>
                <button
                  type="button"
                  className="pick-item"
                  disabled={already || link.isPending}
                  onClick={() => link.mutate({ otherCardId: c.id, direction }, { onSuccess: onClose })}
                >
                  <span className="pick-title">{c.title}</span>
                  <span className="muted small">
                    #{c.id} · {c.archivedAt ? 'Archived' : c.columnName}
                    {already && ' · already linked'}
                  </span>
                </button>
              </li>
            );
          })}
          {data && results.length === 0 && <li className="muted pick-empty">No cards found.</li>}
        </ul>
      </div>
    </Modal>
  );
}

// "Seen this before?": on an open ticket, finished tickets that look like it and how they ended,
// so an old fix is one click away. Shows nothing when there are none.

import type { CardDetail, SimilarTicket } from '@tt/shared';
import { Check, ChevronDown, ChevronRight, History, Link2 } from 'lucide-react';
import { useId, useState } from 'react';
import { useLinkActions } from '../../api/cardParts';
import { useSimilarForCard } from '../../api/phase3';
import { useOpenCard } from '../../lib/navigation';
import { formatDateTime, useNow } from '../../lib/time';
import { TicketTitle } from '../common/TicketTitle';

export function SeenBefore({ card }: { card: CardDetail }) {
  const { data } = useSimilarForCard(card, true);
  const [open, setOpen] = useState(true);
  // Linked here: the server leaves them out from now on, but they stay in place (marked linked)
  // while the card is open, so the list doesn't jump and keyboard focus has somewhere to stay.
  const [linked, setLinked] = useState<SimilarTicket[]>([]);
  const listId = useId();
  const shown = [...(data ?? []).filter((s) => !linked.some((l) => l.id === s.id)), ...linked];
  if (!shown.length) return null;
  return (
    <section className="card-section seen-before" aria-labelledby={`${listId}-heading`}>
      <h3 id={`${listId}-heading`} className="card-section-title">
        <button type="button" className="seen-before-toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
          <History size={16} aria-hidden /> Seen this before? <span className="muted">({shown.length})</span>
        </button>
      </h3>
      <ul id={listId} className="link-list seen-before-list" hidden={!open}>
        {shown.map((s) => (
          <SimilarRow
            key={s.id}
            cardId={card.id}
            similar={s}
            isLinked={linked.some((l) => l.id === s.id)}
            onLinked={() => setLinked((prev) => [...prev, s])}
          />
        ))}
      </ul>
    </section>
  );
}

/** One finished ticket: open it and see how it ended. */
function SimilarSummary({ similar: s, onOpen }: { similar: SimilarTicket; onOpen: (id: number) => void }) {
  const now = useNow();
  return (
    <div className="seen-before-main">
      <button type="button" className="link-row-main" onClick={() => onOpen(s.id)}>
        <span className="link-row-title">
          <TicketTitle ticketNo={s.ticketNo}>{s.title}</TicketTitle>
        </span>
        <span className="muted small">
          {s.resolution ? <span className="badge resolution-badge">{s.resolution}</span> : 'Done'} {formatDateTime(s.completedAt, now)}
          {s.archived && ' · archived'}
        </span>
        {s.note && <span className="seen-before-note small">{s.note}</span>}
      </button>
      {/* No note of its own: the story may be on the work card it was part of. */}
      {!s.note && s.parent && (
        <button type="button" className="btn btn-sm btn-subtle seen-before-parent" onClick={() => onOpen(s.parent!.id)}>
          Part of work card <TicketTitle ticketNo={s.parent.ticketNo}>{s.parent.title}</TicketTitle>
        </button>
      )}
    </div>
  );
}

function SimilarRow({
  cardId,
  similar: s,
  isLinked,
  onLinked,
}: {
  cardId: number;
  similar: SimilarTicket;
  isLinked: boolean;
  onLinked: () => void;
}) {
  const openCard = useOpenCard();
  const { link } = useLinkActions(cardId);
  return (
    <li className="link-row seen-before-row">
      <SimilarSummary similar={s} onOpen={openCard} />
      {/* aria-disabled rather than disabled, so focus stays on the button once it's linked. */}
      <button
        type="button"
        className="btn btn-sm btn-subtle"
        aria-disabled={isLinked || link.isPending}
        aria-label={isLinked ? `“${s.title}” is linked as related` : `Link “${s.title}” as related`}
        onClick={() => {
          if (isLinked || link.isPending) return;
          link.mutate({ otherCardId: s.id, direction: 'relates' }, { onSuccess: onLinked });
        }}
      >
        {isLinked ? <Check size={14} aria-hidden /> : <Link2 size={14} aria-hidden />} {isLinked ? 'Linked' : 'Link'}
      </button>
    </li>
  );
}

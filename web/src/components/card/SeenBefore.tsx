// "Seen this before?": on an open ticket, finished tickets that look like it and how they ended,
// so an old fix is one click away. Shows nothing when there are none.

import { useQueryClient } from '@tanstack/react-query';
import type { CardDetail, SimilarTicket } from '@tt/shared';
import { ChevronDown, ChevronRight, History, Link2 } from 'lucide-react';
import { useId, useState } from 'react';
import { useLinkActions } from '../../api/cardParts';
import { qk } from '../../api/keys';
import { useSimilarForCard } from '../../api/phase3';
import { useOpenCard } from '../../lib/navigation';
import { formatDateTime, useNow } from '../../lib/time';
import { toast } from '../../lib/toast';
import { TicketTitle } from '../common/TicketTitle';

export function SeenBefore({ card }: { card: CardDetail }) {
  const { data } = useSimilarForCard(card, true);
  const [open, setOpen] = useState(true);
  const listId = useId();
  if (!data?.length) return null;
  return (
    <section className="card-section seen-before" aria-labelledby={`${listId}-heading`}>
      <h3 id={`${listId}-heading`} className="card-section-title">
        <button type="button" className="seen-before-toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
          <History size={16} aria-hidden /> Seen this before? <span className="muted">({data.length})</span>
        </button>
      </h3>
      {open && (
        <ul id={listId} className="link-list seen-before-list">
          {data.map((s) => (
            <SimilarRow key={s.id} cardId={card.id} similar={s} />
          ))}
        </ul>
      )}
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
      {!s.note && s.parent && (
        <button type="button" className="btn btn-sm btn-subtle seen-before-parent" onClick={() => onOpen(s.parent!.id)}>
          Finished with work card <TicketTitle ticketNo={s.parent.ticketNo}>{s.parent.title}</TicketTitle>
        </button>
      )}
    </div>
  );
}

function SimilarRow({ cardId, similar: s }: { cardId: number; similar: SimilarTicket }) {
  const openCard = useOpenCard();
  const qc = useQueryClient();
  const { link } = useLinkActions(cardId);
  return (
    <li className="link-row seen-before-row">
      <SimilarSummary similar={s} onOpen={openCard} />
      <button
        type="button"
        className="btn btn-sm btn-subtle"
        disabled={link.isPending}
        aria-label={`Link “${s.title}” as related`}
        onClick={() =>
          link.mutate(
            { otherCardId: s.id, direction: 'relates' },
            {
              onSuccess: () => {
                void qc.invalidateQueries({ queryKey: qk.similar });
                toast('Linked as related', { kind: 'success', durationMs: 2000 });
              },
            },
          )
        }
      >
        <Link2 size={14} aria-hidden /> Link
      </button>
    </li>
  );
}

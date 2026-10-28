// Linked cards, grouped as "Blocked by", "Blocks" and "Related". Each link shows on both cards.
// Clicking a linked card opens it (over the same background page).

import type { CardDetail, CardLink, LinkDirection } from '@tt/shared';
import { Ban, CircleCheck, Link2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useBoard } from '../../api/board';
import { useLinkActions } from '../../api/cardParts';
import { useOpenCard } from '../../lib/navigation';
import { toast } from '../../lib/toast';
import { CardPicker } from '../common/CardPicker';
import { TicketTitle } from '../common/TicketTitle';

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
            const open = direction === 'blocked_by' ? links.filter((l) => !l.card.completedAt).length : 0;
            return (
              <div key={direction} className="link-group">
                <h4 className="link-group-title">{title}</h4>
                {open > 0 && !card.completedAt && (
                  <p className="blocked-note" role="note">
                    <Ban size={14} aria-hidden /> Can&apos;t be marked done until {open === 1 ? 'the open card below is' : `the ${open} open cards below are`}{' '}
                    done.
                  </p>
                )}
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
        <span className="link-row-title">
          <TicketTitle ticketNo={c.ticketNo}>{c.title}</TicketTitle>
        </span>
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
  const { link } = useLinkActions(card.id);
  const { data: board } = useBoard();
  const linked = new Set(card.links.filter((l) => l.direction === direction).map((l) => l.card.id));

  return (
    <CardPicker
      title="Link a card"
      exclude={[card.id]}
      unavailable={(c) => (linked.has(c.id) ? 'already linked' : null)}
      busy={link.isPending}
      onClose={onClose}
      onPick={(c) =>
        link.mutate(
          { otherCardId: c.id, direction },
          {
            onSuccess: (updated) => {
              onClose();
              if (updated.columnId !== card.columnId) {
                const name = board?.columns.find((col) => col.id === updated.columnId)?.name ?? 'another column';
                toast(`Blocked, so moved to ${name}`, { kind: 'info', durationMs: 3000 });
              }
            },
          },
        )
      }
    >
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
    </CardPicker>
  );
}

// Work cards and "part of" in the card view:
//  - Type: Ticket (records an issue) or Work card (what you're working on; tickets file under it)
//  - Tickets: "Part of" the work card they're filed under, which can be changed or cleared
//  - Work cards: the tickets filed under them, plus "Add ticket here" and "File a ticket"

import type { CardDetail, CardKind } from '@tt/shared';
import { CircleCheck, FilePlus2, FolderInput, FolderOpen, X } from 'lucide-react';
import { useState } from 'react';
import { useSetParent, useUpdateCard } from '../../api/cards';
import { errorMessage } from '../../api/errors';
import { useOpenCard } from '../../lib/navigation';
import { toast } from '../../lib/toast';
import { CardPicker } from '../common/CardPicker';
import { TicketTitle } from '../common/TicketTitle';
import { useShell } from '../shell/ShellContext';

export function Family({ card, readOnly }: { card: CardDetail; readOnly: boolean }) {
  const update = useUpdateCard(card.id);
  const setParent = useSetParent();
  const openCard = useOpenCard();
  const shell = useShell();
  const [picking, setPicking] = useState<'parent' | 'child' | null>(null);
  const isWork = card.kind === 'work';
  const typeBlocked =
    isWork && card.children.length > 0
      ? `Move its ${card.children.length} ticket${card.children.length === 1 ? '' : 's'} out first`
      : null;

  function setKind(kind: CardKind) {
    if (kind === card.kind) return;
    // A ticket that's filed somewhere leaves its work card when it becomes a work card itself.
    update.mutate(kind === 'work' && card.parent ? { kind, parentId: null } : { kind }, {
      onSuccess: () => toast(kind === 'work' ? 'Now a work card' : 'Now a ticket', { kind: 'success', durationMs: 2000 }),
      onError: (err) => toast(errorMessage(err), { kind: 'error' }),
    });
  }

  return (
    <section className="card-section family" aria-label="Type and work card">
      <div className="family-row">
        <div className="segmented family-type" role="radiogroup" aria-label="Card type">
          {(
            [
              ['ticket', 'Ticket'],
              ['work', 'Work card'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={card.kind === value}
              className="segmented-item"
              disabled={readOnly || update.isPending || (value === 'ticket' && typeBlocked !== null)}
              title={value === 'ticket' && typeBlocked ? typeBlocked : undefined}
              onClick={() => setKind(value)}
            >
              {value === 'work' && <FolderOpen size={14} aria-hidden />} {label}
            </button>
          ))}
        </div>

        {!isWork && (
          <div className="family-parent">
            <span className="field-inline-label">
              <FolderInput size={14} aria-hidden /> Part of
            </span>
            {card.parent ? (
              <>
                <button type="button" className="link-btn family-parent-link" onClick={() => openCard(card.parent!.id)}>
                  <TicketTitle ticketNo={card.parent.ticketNo}>{card.parent.title}</TicketTitle>
                </button>
                {card.parent.archivedAt && <span className="tag">Archived</span>}
                {!readOnly && (
                  <>
                    <button type="button" className="btn btn-sm btn-subtle" onClick={() => setPicking('parent')}>
                      Change
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label="Take it out of this work card"
                      onClick={() => update.mutate({ parentId: null })}
                    >
                      <X size={16} aria-hidden />
                    </button>
                  </>
                )}
              </>
            ) : readOnly ? (
              <span className="muted">None</span>
            ) : (
              <button type="button" className="btn btn-sm" onClick={() => setPicking('parent')}>
                Choose a work card…
              </button>
            )}
          </div>
        )}
      </div>

      {isWork && (
        <div className="family-children">
          <h3 className="card-section-title">
            <FolderOpen size={16} aria-hidden /> Tickets
            {card.children.length > 0 && (
              <span className="muted small">
                {card.children.filter((c) => c.completedAt).length}/{card.children.length} done
              </span>
            )}
          </h3>
          {card.children.length === 0 ? (
            <p className="muted small">No tickets filed here yet.</p>
          ) : (
            <ul className="link-list">
              {card.children.map((c) => (
                <li key={c.id} className="link-row">
                  <button type="button" className="link-row-main" onClick={() => openCard(c.id)}>
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
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Take “${c.title}” out of this work card`}
                      onClick={() => setParent.mutate({ cardId: c.id, parentId: null })}
                    >
                      <X size={16} aria-hidden />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {!readOnly && (
            <div className="editor-actions">
              <button
                type="button"
                className="btn btn-sm"
                // New tickets start in the work card's column, unless it's already done (then Triage).
                onClick={() => shell.openNewTicket('blank', { parentId: card.id, ...(card.completedAt ? {} : { columnId: card.columnId }) })}
              >
                <FilePlus2 size={14} aria-hidden /> Add ticket here
              </button>
              <button type="button" className="btn btn-sm btn-subtle" onClick={() => setPicking('child')}>
                <FolderInput size={14} aria-hidden /> File a ticket…
              </button>
            </div>
          )}
        </div>
      )}

      {picking === 'parent' && (
        <CardPicker
          title="Part of which work card?"
          kind="work"
          status="board"
          empty="No work cards found. Make one with the Type switch on any card."
          exclude={[card.id, ...(card.parent ? [card.parent.id] : [])]}
          onClose={() => setPicking(null)}
          onPick={(p) =>
            update.mutate(
              { parentId: p.id },
              {
                onSuccess: () => setPicking(null),
                onError: (err) => toast(errorMessage(err), { kind: 'error' }),
              },
            )
          }
        />
      )}
      {picking === 'child' && (
        <CardPicker
          title="File a ticket here"
          kind="ticket"
          status="board"
          empty="No tickets found."
          exclude={[card.id, ...card.children.map((c) => c.id)]}
          onClose={() => setPicking(null)}
          onPick={(c) =>
            setParent.mutate(
              { cardId: c.id, parentId: card.id },
              {
                onSuccess: () => setPicking(null),
                onError: (err) => toast(errorMessage(err), { kind: 'error' }),
              },
            )
          }
        />
      )}
    </section>
  );
}

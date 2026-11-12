import { LIMITS, type CardDetail } from '@tt/shared';
import { useEffect, useRef, useState } from 'react';
import { CONFLICT_MESSAGE, useUpdateCard } from '../../api/cards';
import { conflictCard } from '../../api/errors';
import { toast } from '../../lib/toast';
import { AutoGrowTextarea } from '../common/AutoGrowTextarea';
import { TicketTitle } from '../common/TicketTitle';

interface Props {
  card: CardDetail;
  titleId: string;
  readOnly?: boolean;
  onDirtyChange: (dirty: boolean) => void;
}

/** Click the title to edit; Enter or leaving the field saves, Esc cancels. */
export function TitleEditor({ card, titleId, readOnly = false, onDirtyChange }: Props) {
  const update = useUpdateCard(card.id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(card.title);
  // Esc cancels; a blur fired while the textarea unmounts must not save the cancelled text.
  const editingRef = useRef(false);
  // The saved title the draft started from: if a refresh brings in another one meanwhile, Save
  // says so first instead of quietly replacing it (the request would carry the newer version).
  const base = useRef(card.title);

  const dirty = editing && draft.trim() !== card.title;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  function open(text: string, from: string) {
    setDraft(text);
    base.current = from;
    editingRef.current = true;
    setEditing(true);
  }

  function stop() {
    editingRef.current = false;
    setEditing(false);
  }

  function start() {
    if (readOnly) return;
    open(card.title, card.title);
  }

  function save() {
    if (!editingRef.current) return;
    const title = draft.replace(/\s+/g, ' ').trim();
    stop();
    if (!title || title === card.title) return;
    if (card.title !== base.current) {
      // Changed on another device while you typed: keep your text; saving again replaces theirs.
      toast(CONFLICT_MESSAGE, { kind: 'warning' });
      open(title, card.title);
      return;
    }
    update.mutate(
      { title },
      {
        onError: (err) => {
          // Someone else changed the card: reopen with the user's text so it isn't lost.
          const current = conflictCard(err);
          if (current) open(title, current.title);
        },
      },
    );
  }

  return (
    <>
      <h2 id={titleId} className={editing ? 'visually-hidden' : 'card-title'}>
        {editing || readOnly ? (
          <TicketTitle ticketNo={card.ticketNo}>{card.title}</TicketTitle>
        ) : (
          <button type="button" className="card-title-btn" onClick={start} title="Click to edit the title">
            <span className="card-title-text">
              <TicketTitle ticketNo={card.ticketNo}>{card.title}</TicketTitle>
            </span>
          </button>
        )}
      </h2>
      {editing && card.ticketNo && <span className="ticket-no card-title-ticket">{card.ticketNo}</span>}
      {editing && (
        <AutoGrowTextarea
          className="input card-title-input"
          aria-label="Card title"
          value={draft}
          maxLength={LIMITS.cardTitle}
          rows={1}
          autoFocus
          enterKeyHint="done"
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setDraft(e.target.value.replace(/[\r\n]+/g, ' '))}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              save();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              stop();
            }
          }}
          onBlur={save}
        />
      )}
    </>
  );
}

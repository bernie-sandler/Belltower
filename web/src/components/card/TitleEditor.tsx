import { LIMITS, type CardDetail } from '@tt/shared';
import { useEffect, useRef, useState } from 'react';
import { useUpdateCard } from '../../api/cards';
import { conflictCard } from '../../api/errors';
import { AutoGrowTextarea } from '../common/AutoGrowTextarea';

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

  const dirty = editing && draft.trim() !== card.title;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  function open(text: string) {
    setDraft(text);
    editingRef.current = true;
    setEditing(true);
  }

  function stop() {
    editingRef.current = false;
    setEditing(false);
  }

  function start() {
    if (readOnly) return;
    open(card.title);
  }

  function save() {
    if (!editingRef.current) return;
    const title = draft.replace(/\s+/g, ' ').trim();
    stop();
    if (!title || title === card.title) return;
    update.mutate(
      { title },
      {
        onError: (err) => {
          // Someone else changed the card: reopen with the user's text so it isn't lost.
          if (conflictCard(err)) open(title);
        },
      },
    );
  }

  return (
    <>
      <h2 id={titleId} className={editing ? 'visually-hidden' : 'card-title'}>
        {editing || readOnly ? (
          card.title
        ) : (
          <button type="button" className="card-title-btn" onClick={start} title="Click to edit the title">
            <span className="card-title-text">{card.title}</span>
          </button>
        )}
      </h2>
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

import { LIMITS } from '@tt/shared';
import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useCreateCard } from '../../api/cards';
import { tempId } from '../../lib/ids';
import { AutoGrowTextarea } from '../common/AutoGrowTextarea';

interface Props {
  columnId: number;
  /** Number of cards in the column; when it grows we keep the composer in view. */
  cardCount: number;
  onClose: () => void;
}

/**
 * Trello-style "add a card" composer. Enter adds the card and keeps the composer open for the
 * next one; Shift+Enter does nothing (titles are single-line); Esc closes.
 */
export function AddCardComposer({ columnId, cardCount, onClose }: Props) {
  const create = useCreateCard();
  const [title, setTitle] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, []);

  // A card was added above us: stay visible for rapid entry.
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [cardCount]);

  function submit() {
    const clean = title.replace(/\s+/g, ' ').trim().slice(0, LIMITS.cardTitle);
    if (!clean) return;
    create.mutate({ title: clean, columnId, tempId: tempId() });
    setTitle('');
    ref.current?.focus({ preventScroll: true });
  }

  return (
    <div className="composer">
      <AutoGrowTextarea
        ref={ref}
        className="input composer-input"
        placeholder="Enter a title for this card…"
        aria-label="New card title"
        rows={2}
        maxLength={LIMITS.cardTitle}
        value={title}
        onChange={(e) => setTitle(e.target.value.replace(/[\r\n]+/g, ' '))}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') {
            e.preventDefault(); // never insert a newline
            if (!e.shiftKey) submit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
        onBlur={() => {
          if (!title.trim()) onClose();
        }}
      />
      <div className="composer-actions">
        <button
          type="button"
          className="btn btn-primary"
          onMouseDown={(e) => e.preventDefault()} // keep focus in the textarea
          onClick={submit}
        >
          Add card
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Close composer"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClose}
        >
          <X size={18} aria-hidden />
        </button>
      </div>
    </div>
  );
}

// Plain-text description editor (Markdown rendering arrives in Phase 2).
//
// Concurrency: the draft remembers the saved text it started from (`base`). If the saved text
// changes while editing — another device saved, or the server answered 409 — the editor keeps
// the draft, shows a notice with the current text, and the next Save overwrites deliberately.
// Drafts are mirrored to sessionStorage so an accidental Back/close doesn't lose them.

import { LIMITS, type CardDetail } from '@tt/shared';
import { AlignLeft } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { CONFLICT_MESSAGE, useUpdateCard } from '../../api/cards';
import { conflictCard } from '../../api/errors';
import { clearDraft, loadDraft, saveDraft } from '../../lib/drafts';
import { toast } from '../../lib/toast';
import { AutoGrowTextarea } from '../common/AutoGrowTextarea';

interface Props {
  card: CardDetail;
  readOnly?: boolean;
  onDirtyChange: (dirty: boolean) => void;
}

export function descriptionDraftKey(cardId: number): string {
  return `card:${cardId}:description`;
}

export function DescriptionEditor({ card, readOnly = false, onDirtyChange }: Props) {
  const draftKey = descriptionDraftKey(card.id);
  const update = useUpdateCard(card.id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [base, setBase] = useState(card.description);
  const [restored, setRestored] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [showCurrent, setShowCurrent] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const focusOnOpen = useRef(false);

  // Bring back a draft left behind by an earlier visit (only once per card).
  const restoredFor = useRef<number | null>(null);
  useEffect(() => {
    if (restoredFor.current === card.id) return;
    restoredFor.current = card.id;
    const saved = loadDraft(draftKey);
    if (saved === null) return;
    if (saved === card.description) {
      clearDraft(draftKey);
      return;
    }
    setDraft(saved);
    setBase(card.description);
    setRestored(true);
    setEditing(true);
  }, [card.id, card.description, draftKey]);

  useEffect(() => {
    if (editing && focusOnOpen.current) {
      focusOnOpen.current = false;
      textRef.current?.focus();
    }
  }, [editing]);

  const dirty = editing && draft !== base;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const changedElsewhere = editing && card.description !== base;

  function start() {
    if (readOnly) return;
    setDraft(card.description);
    setBase(card.description);
    setReviewed(false);
    setShowCurrent(false);
    setRestored(false);
    focusOnOpen.current = true;
    setEditing(true);
  }

  function close() {
    clearDraft(draftKey);
    setEditing(false);
    setRestored(false);
    setShowCurrent(false);
    setReviewed(false);
  }

  function change(value: string) {
    setDraft(value);
    saveDraft(draftKey, value);
  }

  function save() {
    if (changedElsewhere && !reviewed) {
      toast(CONFLICT_MESSAGE, { kind: 'warning' });
      setReviewed(true);
      setShowCurrent(true);
      return;
    }
    if (draft === card.description) {
      close();
      return;
    }
    update.mutate(
      { description: draft },
      {
        onSuccess: close,
        onError: (err) => {
          if (conflictCard(err)) {
            // The mutation already replaced the cached card and showed the toast.
            setReviewed(true);
            setShowCurrent(true);
          }
        },
      },
    );
  }

  return (
    <section className="card-section" aria-labelledby="card-description-heading">
      <div className="card-section-head">
        <h3 id="card-description-heading" className="card-section-title">
          <AlignLeft size={16} aria-hidden /> Description
        </h3>
        {!editing && !readOnly && card.description && (
          <button type="button" className="btn btn-sm" onClick={start}>
            Edit
          </button>
        )}
      </div>

      {editing ? (
        <div className="description-editor">
          {restored && !changedElsewhere && <p className="notice">Restored your unsaved draft.</p>}
          {changedElsewhere && (
            <div className="notice notice-warning" role="status">
              <p>This description was changed on another device. Saving will replace it with your text.</p>
              <p>
                <button type="button" className="link-btn" onClick={() => setShowCurrent((s) => !s)}>
                  {showCurrent ? 'Hide current text' : 'Show current text'}
                </button>
                {' · '}
                <button type="button" className="link-btn" onClick={close}>
                  Discard my draft
                </button>
              </p>
              {showCurrent && <div className="description-text is-current">{card.description || '(empty)'}</div>}
            </div>
          )}
          <AutoGrowTextarea
            ref={textRef}
            className="input description-input"
            aria-label="Description"
            placeholder="Add a more detailed description…"
            rows={6}
            maxLength={LIMITS.description}
            value={draft}
            onChange={(e) => change(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                // Leave the field but keep the draft; a second Esc closes the card (with a prompt).
                e.preventDefault();
                e.currentTarget.blur();
              } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                save();
              }
            }}
          />
          <div className="editor-actions">
            <button type="button" className="btn btn-primary" onClick={save} disabled={update.isPending}>
              {update.isPending ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="btn" onClick={close} disabled={update.isPending}>
              Cancel
            </button>
          </div>
        </div>
      ) : card.description ? (
        <div className="description-text" onDoubleClick={start}>
          {card.description}
        </div>
      ) : readOnly ? (
        <p className="muted">No description.</p>
      ) : (
        <button type="button" className="description-placeholder" onClick={start}>
          Add a more detailed description…
        </button>
      )}
    </section>
  );
}

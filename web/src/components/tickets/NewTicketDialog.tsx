// Add ticket. "Describe the issue": you write the problem in your own words, Claude drafts the
// card (title, details, priority from impact × urgency, severity, labels, checklist) and you review
// every field before anything is saved. "Blank ticket" (or any drafting failure) goes straight to
// the same form, empty.

import { LIMITS, type TicketDraft } from '@tt/shared';
import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { useBoard } from '../../api/board';
import { errorMessage } from '../../api/errors';
import { useAiStatus, useCreateTicket, useDraftTicket } from '../../api/tickets';
import { clearDraft, loadDraft, saveDraft } from '../../lib/drafts';
import { useOpenCard } from '../../lib/navigation';
import { toast } from '../../lib/toast';
import { AutoGrowTextarea } from '../common/AutoGrowTextarea';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { Modal } from '../common/Modal';
import { Spinner } from '../common/Status';
import { emptyTicket, fromDraft, TicketForm, toCreateBody, type TicketFields } from './TicketForm';

export type NewTicketMode = 'describe' | 'blank';

const TEXT_DRAFT = 'new-ticket-text';

export function NewTicketDialog({ mode, onClose }: { mode: NewTicketMode; onClose: () => void }) {
  const ai = useAiStatus();
  const board = useBoard();
  const draft = useDraftTicket();
  const create = useCreateTicket();
  const openCard = useOpenCard();

  const canDraft = ai.data?.enabled === true;
  const [step, setStep] = useState<'describe' | 'form'>(mode === 'describe' && canDraft ? 'describe' : 'form');
  const [text, setText] = useState(() => loadDraft(TEXT_DRAFT) ?? '');
  const [fields, setFields] = useState<TicketFields>(emptyTicket);
  const [suggestion, setSuggestion] = useState<TicketDraft | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);

  function changeText(v: string) {
    setText(v);
    saveDraft(TEXT_DRAFT, v);
  }

  function runDraft() {
    if (!text.trim() || draft.isPending) return;
    setNotice(null);
    draft.mutate(text.trim(), {
      onSuccess: (d) => {
        setSuggestion(d);
        setFields(fromDraft(d));
        setStep('form');
      },
      onError: (err) => {
        // Fall back to filling it in by hand, starting from what was typed.
        setSuggestion(null);
        setFields({ ...emptyTicket(), title: firstLine(text), description: text.trim() });
        setNotice(`${errorMessage(err)} Fill in the ticket yourself below.`);
        setStep('form');
      },
    });
  }

  function submit() {
    setError(null);
    if (!fields.title.trim()) {
      setError('A title is required.');
      return;
    }
    create.mutate(toCreateBody(fields, suggestion !== null), {
      onSuccess: (card) => {
        clearDraft(TEXT_DRAFT);
        onClose();
        toast('Ticket created', { kind: 'success', action: { label: 'Open', onClick: () => openCard(card.id) } });
      },
      onError: (err) => setError(errorMessage(err)),
    });
  }

  // A form with content (especially a paid-for draft) asks before it's thrown away.
  const dirty = step === 'form' && (suggestion !== null || fields.title.trim() !== '' || fields.description.trim() !== '');
  const requestClose = () => (dirty && !create.isPending ? setConfirmClose(true) : onClose());

  return (
    <Modal
      onClose={requestClose}
      title={step === 'describe' ? 'Describe the issue' : suggestion ? 'Review the ticket' : 'New ticket'}
      variant="sheet"
      size="lg"
      className="new-ticket"
    >
      {step === 'describe' ? (
        <>
          <div className="modal-body">
            <AutoGrowTextarea
              className="input new-ticket-text"
              aria-label="What's wrong?"
              placeholder="What's wrong? Symptoms, error messages, what changed, what you already tried…"
              rows={7}
              maxLength={LIMITS.draftText}
              value={text}
              disabled={draft.isPending}
              onChange={(e) => changeText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  runDraft();
                }
              }}
            />
            {draft.isPending ? (
              <p className="new-ticket-status" aria-live="polite">
                <Spinner size={16} label="Drafting" /> Claude is drafting your ticket. This usually takes 10–30 seconds.
              </p>
            ) : (
              <p className="muted small">
                Claude suggests a title, details, priority, severity, labels and a checklist; you can change anything before
                the card is created. What you type here and your label names are sent to Anthropic.
              </p>
            )}
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-subtle" onClick={() => setStep('form')} disabled={draft.isPending}>
              Fill in by hand
            </button>
            <button type="button" className="btn" onClick={requestClose}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={runDraft} disabled={!text.trim() || draft.isPending}>
              <Sparkles size={16} aria-hidden /> {draft.isPending ? 'Drafting…' : 'Draft with Claude'}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="modal-body">
            {notice && (
              <p className="import-warning" role="alert">
                {notice}
              </p>
            )}
            {mode === 'describe' && !canDraft && !notice && (
              <p className="muted small">Claude drafting is off (no ANTHROPIC_API_KEY on the server), so fill in the ticket yourself.</p>
            )}
            <TicketForm
              fields={fields}
              onChange={setFields}
              suggestion={suggestion}
              columns={board.data?.columns ?? []}
              labels={board.data?.labels ?? []}
              onSubmit={submit}
            />
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="modal-footer">
            {canDraft && mode === 'describe' && (
              <button type="button" className="btn btn-subtle" onClick={() => setStep('describe')} disabled={create.isPending}>
                <Sparkles size={16} aria-hidden /> {suggestion ? 'Redraft' : 'Draft with Claude'}
              </button>
            )}
            <button type="button" className="btn" onClick={requestClose} disabled={create.isPending}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={submit} disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create ticket'}
            </button>
          </div>
        </>
      )}
      {confirmClose && (
        <ConfirmDialog
          title="Discard this ticket?"
          message="The ticket hasn't been created yet."
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          danger
          onCancel={() => setConfirmClose(false)}
          onConfirm={onClose}
        />
      )}
    </Modal>
  );
}

function firstLine(text: string): string {
  const line = text.trim().split('\n', 1)[0] ?? '';
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}

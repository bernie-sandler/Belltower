// Add ticket → "Describe several issues": paste notes, a list or logs; Claude splits them into
// cards (tickets, work cards, links) in the card-import format; you check the same preview as an
// import, then create them all at once. Nothing is saved until "Create".

import { LIMITS, type BulkDraft } from '@tt/shared';
import { ArrowLeft, CircleCheck, Sparkles, XCircle } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../../api/errors';
import { useCreateDrafted, useDraftMany } from '../../api/tickets';
import { clearDraft, loadDraft, saveDraft } from '../../lib/drafts';
import { useOpenCard } from '../../lib/navigation';
import { toast } from '../../lib/toast';
import { AutoGrowTextarea } from '../common/AutoGrowTextarea';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { Modal } from '../common/Modal';
import { Spinner } from '../common/Status';
import { ImportPreviewList } from '../tools/ImportPreview';

const TEXT_DRAFT = 'new-tickets-text';

export function BulkTicketsDialog({ onClose }: { onClose: () => void }) {
  const draft = useDraftMany();
  const create = useCreateDrafted();
  const openCard = useOpenCard();
  const [text, setText] = useState(() => loadDraft(TEXT_DRAFT) ?? '');
  const [result, setResult] = useState<BulkDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);

  const items = result?.preview.items ?? [];
  const valid = items.length > 0 && items.every((i) => i.ok);

  function runDraft() {
    if (!text.trim() || draft.isPending) return;
    setError(null);
    draft.mutate(text.trim(), {
      onSuccess: setResult,
      onError: (err) => setError(errorMessage(err)),
    });
  }

  function createAll() {
    if (!result || !valid) return;
    setError(null);
    create.mutate(result.cards, {
      onSuccess: (r) => {
        clearDraft(TEXT_DRAFT);
        onClose();
        const n = r.created.length;
        toast(`Created ${n} card${n === 1 ? '' : 's'}`, {
          kind: 'success',
          action: n === 1 ? { label: 'Open', onClick: () => openCard(r.created[0]!) } : undefined,
        });
      },
      onError: (err) => setError(errorMessage(err)),
    });
  }

  // A paid-for draft asks before it's thrown away.
  const requestClose = () => (result && !create.isPending ? setConfirmClose(true) : onClose());

  return (
    <Modal onClose={requestClose} title={result ? 'Review the cards' : 'Describe several issues'} variant="sheet" size="lg" className="new-ticket">
      {result ? (
        <>
          <div className="modal-body">
            <p className="import-preview-head">
              {items.length} card{items.length === 1 ? '' : 's'}
              {valid ? (
                <span className="tag tag-success">
                  <CircleCheck size={12} aria-hidden /> Ready
                </span>
              ) : (
                <span className="tag tag-danger">
                  <XCircle size={12} aria-hidden /> Some cards have errors; go back and redraft
                </span>
              )}
            </p>
            <ImportPreviewList items={items} />
            <p className="muted small">Each card can be edited after it’s created.</p>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-subtle" onClick={() => setResult(null)} disabled={create.isPending}>
              <ArrowLeft size={16} aria-hidden /> Back
            </button>
            <button type="button" className="btn" onClick={requestClose} disabled={create.isPending}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={createAll} disabled={!valid || create.isPending}>
              {create.isPending ? 'Creating…' : `Create ${items.length} card${items.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="modal-body">
            <AutoGrowTextarea
              className="input new-ticket-text"
              aria-label="Notes"
              placeholder="Paste notes, a to-do list or logs. Claude makes one card per issue and groups related steps under a work card."
              rows={9}
              maxLength={LIMITS.draftText}
              value={text}
              disabled={draft.isPending}
              onChange={(e) => {
                setText(e.target.value);
                saveDraft(TEXT_DRAFT, e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  runDraft();
                }
              }}
            />
            {draft.isPending ? (
              <p className="new-ticket-status" aria-live="polite">
                <Spinner size={16} label="Drafting" /> Claude is splitting this into cards. This can take up to a minute.
              </p>
            ) : (
              <p className="muted small">
                You’ll see every card before anything is created. What you paste, your label names and your open cards’
                titles are sent to Anthropic.
              </p>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="modal-footer">
            <button type="button" className="btn" onClick={requestClose}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={runDraft} disabled={!text.trim() || draft.isPending}>
              <Sparkles size={16} aria-hidden /> {draft.isPending ? 'Drafting…' : 'Draft cards'}
            </button>
          </div>
        </>
      )}
      {confirmClose && (
        <ConfirmDialog
          title="Discard these cards?"
          message="None of them have been created yet. Your notes are kept."
          confirmLabel="Discard"
          cancelLabel="Keep reviewing"
          danger
          onCancel={() => setConfirmClose(false)}
          onConfirm={onClose}
        />
      )}
    </Modal>
  );
}

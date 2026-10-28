// Mark done with a resolution (mode 'complete'), or add/change it on a card that's already done
// (mode 'edit': from the card view, or the toast after dragging into Done). The reason defaults to
// the first in Settings' list, the note is optional, and Enter accepts.

import { CircleCheck } from 'lucide-react';
import { useState } from 'react';
import { useCard, useCompleteCard, useSetResolution } from '../../api/cards';
import { errorMessage } from '../../api/errors';
import { toast } from '../../lib/toast';
import { Modal } from '../common/Modal';
import { TicketTitle } from '../common/TicketTitle';
import { ResolutionFields, useResolutionReasons, type ResolutionValue } from './ResolutionFields';

interface Props {
  cardId: number;
  mode: 'complete' | 'edit';
  onClose: () => void;
}

export function ResolveDialog({ cardId, mode, onClose }: Props) {
  const { data: card } = useCard(cardId);
  const reasons = useResolutionReasons();
  const complete = useCompleteCard();
  const setResolution = useSetResolution();
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState<ResolutionValue | null>(null);
  // Editing starts from what's recorded (once the card has loaded); otherwise the default reason.
  const current: ResolutionValue =
    value ??
    (mode === 'edit' && card?.resolution ? { reason: card.resolution, note: card.resolutionNote } : { reason: reasons[0]!, note: '' });
  const busy = complete.isPending || setResolution.isPending;

  function submit(v: ResolutionValue) {
    if (busy) return;
    setError(null);
    const resolution = { reason: v.reason, note: v.note.trim() };
    if (mode === 'complete') {
      complete.mutate(
        { id: cardId, includeChildren: false, resolution },
        {
          onSuccess: () => {
            onClose();
            toast(`Marked done: ${resolution.reason}`, { kind: 'success', durationMs: 2500 });
          },
          onError: (err) => setError(errorMessage(err)),
        },
      );
    } else {
      setResolution.mutate(
        { cardId, resolution },
        {
          onSuccess: () => {
            onClose();
            toast('Resolution saved', { kind: 'success', durationMs: 2500 });
          },
          onError: (err) => setError(errorMessage(err)),
        },
      );
    }
  }

  return (
    <Modal title={mode === 'complete' ? 'Mark done' : 'Resolution'} variant="sheet" size="sm" onClose={onClose}>
      <form
        className="modal-body resolve-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          submit(current);
        }}
      >
        {card && (
          <p className="resolve-card">
            <strong>
              <TicketTitle ticketNo={card.ticketNo}>{card.title}</TicketTitle>
            </strong>
          </p>
        )}
        <ResolutionFields value={current} onChange={setValue} onSubmit={submit} disabled={busy} />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>
      <div className="modal-footer">
        {mode === 'edit' && card?.resolution && (
          <button
            type="button"
            className="btn btn-subtle resolve-clear"
            disabled={busy}
            onClick={() =>
              setResolution.mutate(
                { cardId, resolution: null },
                { onSuccess: onClose, onError: (err) => setError(errorMessage(err)) },
              )
            }
          >
            Clear
          </button>
        )}
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn-success" onClick={() => submit(current)} disabled={busy}>
          <CircleCheck size={16} aria-hidden /> {mode === 'complete' ? 'Mark done' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}

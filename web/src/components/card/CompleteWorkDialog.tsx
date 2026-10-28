// Mark done on a work card that still has open tickets: complete it alone, or together with its
// tickets. All or nothing: if any ticket is blocked by an open card outside the set, nothing moves
// and the dialog lists what's stuck. The resolution chosen here applies to every card completed.

import { Ban, CircleCheck } from 'lucide-react';
import { useState } from 'react';
import { useBoard } from '../../api/board';
import { stuckCards, useCompleteCard, type StuckCard } from '../../api/cards';
import { errorMessage } from '../../api/errors';
import { toast } from '../../lib/toast';
import { Modal } from '../common/Modal';
import { TicketTitle } from '../common/TicketTitle';
import { ResolutionFields, useResolutionReasons, type ResolutionValue } from './ResolutionFields';

interface Props {
  card: { id: number; title: string; ticketNo: string | null };
  onClose: () => void;
}

export function CompleteWorkDialog({ card, onClose }: Props) {
  const { data: board } = useBoard();
  const complete = useCompleteCard();
  const [stuck, setStuck] = useState<StuckCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reasons = useResolutionReasons();
  const [chosen, setChosen] = useState<ResolutionValue | null>(null);
  const resolution = chosen ?? { reason: reasons[0]!, note: '' };

  const open = (board?.cards ?? []).filter((c) => c.parentId === card.id && !c.completedAt && c.id > 0);
  // The board knows which tickets are blocked; blockers inside the set are fine, so the server has
  // the final word (and fills `stuck` from its answer).
  const likelyStuck = open.filter((c) => c.blockedBy > 0);
  const shownStuck = stuck ?? (likelyStuck.length ? likelyStuck.map((c) => ({ id: c.id, ticketNo: c.ticketNo, title: c.title, blockers: [] })) : null);

  function run(includeChildren: boolean, res: ResolutionValue = resolution) {
    if (complete.isPending) return;
    setError(null);
    complete.mutate(
      { id: card.id, includeChildren, resolution: { reason: res.reason, note: res.note.trim() } },
      {
        onSuccess: (res) => {
          onClose();
          const n = res.completed.length - 1;
          toast(n > 0 ? `Completed with ${n} ticket${n === 1 ? '' : 's'}` : 'Marked done', { kind: 'success', durationMs: 2500 });
        },
        onError: (err) => {
          const s = stuckCards(err);
          if (s) setStuck(s);
          else setError(errorMessage(err));
        },
      },
    );
  }

  return (
    <Modal title="Mark done" variant="sheet" size="sm" onClose={onClose}>
      <div className="modal-body complete-work">
        <p>
          <strong>
            <TicketTitle ticketNo={card.ticketNo}>{card.title}</TicketTitle>
          </strong>{' '}
          has {open.length} open ticket{open.length === 1 ? '' : 's'}:
        </p>
        <ul className="complete-work-list">
          {open.map((c) => (
            <li key={c.id}>
              <TicketTitle ticketNo={c.ticketNo}>{c.title}</TicketTitle>
              {c.blockedBy > 0 && (
                <span className="badge blocked-badge">
                  <Ban size={12} aria-hidden /> Blocked
                </span>
              )}
            </li>
          ))}
        </ul>
        {shownStuck && shownStuck.length > 0 && (
          <div className="import-warning complete-work-stuck" role="alert">
            <Ban size={14} aria-hidden />
            <span>
              {shownStuck.length === 1 ? 'This ticket is' : `${shownStuck.length} tickets are`} still blocked by open cards, so they
              can&apos;t all be completed together:{' '}
              {shownStuck
                .map((s) => `${s.ticketNo ?? `#${s.id}`}${s.blockers.length ? ` (by ${s.blockers.map((b) => `“${b.title}”`).join(', ')})` : ''}`)
                .join('; ')}
            </span>
          </div>
        )}
        <ResolutionFields
          value={resolution}
          onChange={setChosen}
          onSubmit={(v) => run(!(stuck !== null && stuck.length > 0), v)}
          disabled={complete.isPending}
        />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn" onClick={onClose} disabled={complete.isPending}>
          Cancel
        </button>
        <button type="button" className="btn" onClick={() => run(false)} disabled={complete.isPending}>
          Only this card
        </button>
        <button
          type="button"
          className="btn btn-success"
          onClick={() => run(true)}
          disabled={complete.isPending || (stuck !== null && stuck.length > 0)}
        >
          <CircleCheck size={16} aria-hidden /> Complete with {open.length} ticket{open.length === 1 ? '' : 's'}
        </button>
      </div>
    </Modal>
  );
}

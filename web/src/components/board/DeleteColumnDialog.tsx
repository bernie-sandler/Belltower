import type { Column } from '@tt/shared';
import { useState } from 'react';
import { isApiError } from '../../api/client';
import { useDeleteColumn } from '../../api/columns';
import { errorMessage } from '../../api/errors';
import { toast } from '../../lib/toast';
import { ConfirmDialog } from '../common/ConfirmDialog';

interface Props {
  column: Column;
  columns: Column[];
  /** Board-visible cards in the column. */
  cardCount: number;
  onClose: () => void;
}

/**
 * Deleting a column moves its cards to the bottom of a target column. The board only knows
 * about visible cards; if the server says archived/deleted cards remain (400 target_required),
 * the dialog asks for a target too.
 */
export function DeleteColumnDialog({ column, columns, cardCount, onClose }: Props) {
  const del = useDeleteColumn();
  const others = columns.filter((c) => c.id !== column.id);
  const [needsTarget, setNeedsTarget] = useState(cardCount > 0);
  const [hiddenCards, setHiddenCards] = useState(false);
  const [target, setTarget] = useState<number | null>(
    () => others.find((c) => c.role === 'triage')?.id ?? others[0]?.id ?? null,
  );
  const [error, setError] = useState<string | null>(null);

  function confirm() {
    setError(null);
    del.mutate(
      { id: column.id, targetColumnId: needsTarget ? target : null },
      {
        onSuccess: () => {
          onClose();
          toast(`Deleted column “${column.name}”`, { kind: 'success' });
        },
        onError: (err) => {
          if (isApiError(err, 'target_required')) {
            setNeedsTarget(true);
            setHiddenCards(true);
          } else {
            setError(errorMessage(err));
          }
        },
      },
    );
  }

  const targetName = others.find((c) => c.id === target)?.name;

  return (
    <ConfirmDialog
      title={`Delete column “${column.name}”?`}
      danger
      confirmLabel="Delete column"
      busy={del.isPending}
      confirmDisabled={needsTarget && target === null}
      onConfirm={confirm}
      onCancel={onClose}
    >
      {needsTarget ? (
        <>
          <p>
            {hiddenCards
              ? 'This column still holds archived or deleted cards.'
              : `This column has ${cardCount} card${cardCount === 1 ? '' : 's'}.`}{' '}
            Choose where they should go:
          </p>
          <label className="field">
            <span className="field-label">Move cards to</span>
            <select
              className="input"
              value={target ?? ''}
              onChange={(e) => setTarget(e.target.value ? Number(e.target.value) : null)}
              data-autofocus
            >
              {others.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <p className="muted small">
            They are added to the bottom of {targetName ? `“${targetName}”` : 'that column'}, and each move is
            recorded in the card&apos;s history.
          </p>
        </>
      ) : (
        <p>The column is empty. This can&apos;t be undone.</p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </ConfirmDialog>
  );
}

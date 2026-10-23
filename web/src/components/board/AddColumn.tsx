import { LIMITS } from '@tt/shared';
import { Plus, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useCreateColumn } from '../../api/columns';

interface Props {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** Called after a column is added (the board scrolls to the end). */
  onAdded: () => void;
}

/** "Add another column" at the end of the board; stays open after adding for rapid entry. */
export function AddColumn({ open, onOpen, onClose, onAdded }: Props) {
  const create = useCreateColumn();
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus({ preventScroll: true });
  }, [open]);

  if (!open) {
    return (
      <div className="add-column">
        <button type="button" className="add-column-btn" onClick={onOpen}>
          <Plus size={16} aria-hidden /> Add another column
        </button>
      </div>
    );
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const clean = name.trim();
    if (!clean || create.isPending) return;
    create.mutate(clean, {
      onSuccess: () => {
        setName('');
        inputRef.current?.focus({ preventScroll: true });
        onAdded();
      },
    });
  }

  return (
    <div className="add-column">
      <form className="add-column-form" onSubmit={submit}>
        <input
          ref={inputRef}
          className="input"
          placeholder="Column name…"
          aria-label="New column name"
          maxLength={LIMITS.columnName}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <div className="composer-actions">
          <button type="submit" className="btn btn-primary" disabled={!name.trim() || create.isPending}>
            Add column
          </button>
          <button type="button" className="icon-btn" aria-label="Cancel adding a column" onClick={onClose}>
            <X size={18} aria-hidden />
          </button>
        </div>
      </form>
    </div>
  );
}

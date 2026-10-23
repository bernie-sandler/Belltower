import { useId, type ReactNode } from 'react';
import { Modal } from './Modal';

interface ConfirmDialogProps {
  title: string;
  message?: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  message,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  busy = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const messageId = useId();
  return (
    <Modal title={title} onClose={onCancel} variant="dialog" size="sm" describedBy={message ? messageId : undefined}>
      <div className="modal-body">
        {message && (
          <p id={messageId} className="confirm-message">
            {message}
          </p>
        )}
        {children}
      </div>
      <footer className="modal-footer">
        {/* Destructive dialogs focus Cancel, so a stray Enter doesn't delete anything. */}
        <button type="button" className="btn" onClick={onCancel} data-autofocus={danger ? true : undefined}>
          {cancelLabel}
        </button>
        <button
          type="button"
          className={danger ? 'btn btn-danger' : 'btn btn-primary'}
          onClick={onConfirm}
          disabled={busy || confirmDisabled}
          aria-busy={busy || undefined}
          data-autofocus={danger ? undefined : true}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </footer>
    </Modal>
  );
}

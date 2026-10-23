// Dialog / bottom sheet / card sheet. One component, laid out by CSS:
//  - 'dialog': centered dialog everywhere.
//  - 'sheet':  bottom sheet on phones, small centered dialog on desktop.
//  - 'card':   full-screen sheet on phones, large modal on desktop (card detail).
// Registers a modal layer (Esc/Back close only the topmost), traps Tab, focuses the first
// field on open and restores focus on close.

import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cls } from '../../lib/cls';
import { initialFocusTarget, restoreFocus, trapTab } from '../../lib/focus';
import { pushLayer } from '../../lib/layers';

export interface ModalProps {
  onClose: () => void;
  children: ReactNode;
  /** Renders the standard header (title + close button) and labels the dialog. */
  title?: ReactNode;
  /** Id of a custom heading when `title` isn't used. */
  labelledBy?: string;
  /** Id of the element that describes the dialog (e.g. a confirm message). */
  describedBy?: string;
  variant?: 'dialog' | 'sheet' | 'card';
  size?: 'sm' | 'md' | 'lg';
  /** Mirror with a history entry so Back closes it (default true; the card route is its own entry). */
  history?: boolean;
  /** 'panel' focuses the dialog itself instead of its first field. */
  initialFocus?: 'auto' | 'panel';
  className?: string;
}

export function Modal({
  onClose,
  children,
  title,
  labelledBy,
  describedBy,
  variant = 'dialog',
  size = 'md',
  history = true,
  initialFocus = 'auto',
  className,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const backdropDown = useRef(false);
  const closeRef = useRef(onClose);
  const titleId = useId();

  useEffect(() => {
    closeRef.current = onClose;
  });

  // Layer registration and focus handling share one effect so the cleanup order is right:
  // the app root stops being inert before focus returns to the element that opened us.
  useEffect(() => {
    const previous = document.activeElement;
    const unregister = pushLayer(() => closeRef.current(), { history, modal: true });
    const panel = panelRef.current;
    if (panel) (initialFocus === 'panel' ? panel : initialFocusTarget(panel)).focus({ preventScroll: true });
    return () => {
      unregister();
      restoreFocus(previous);
    };
    // Mount/unmount only: options are fixed for the lifetime of a modal.
  }, []);

  return createPortal(
    <div className={cls('modal-root', `modal-${variant}`)}>
      <div
        className="modal-backdrop"
        onMouseDown={(e) => {
          backdropDown.current = e.target === e.currentTarget;
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget && backdropDown.current) onClose();
          backdropDown.current = false;
        }}
      />
      <div
        ref={panelRef}
        className={cls('modal-panel', `modal-${size}`, className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title !== undefined ? titleId : labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        onKeyDown={(e) => {
          // React bubbles events from nested portals (a confirm dialog or popover opened from
          // inside this one) through this handler; only trap Tab for our own content.
          const panel = panelRef.current;
          if (panel && panel.contains(e.target as Node)) trapTab(e, panel);
        }}
      >
        {title !== undefined && (
          <header className="modal-header">
            <h2 id={titleId} className="modal-title">
              {title}
            </h2>
            <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
              <X size={18} aria-hidden />
            </button>
          </header>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}

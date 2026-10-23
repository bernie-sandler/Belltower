import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { cls } from '../../lib/cls';
import { dismissToast, useToasts, type ToastKind } from '../../lib/toast';

const ICONS: Record<ToastKind, typeof Info> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  error: CircleAlert,
};

export function Toaster() {
  const toasts = useToasts();
  return createPortal(
    <div className="toaster" role="region" aria-label="Notifications">
      {/* One polite live region; the toasts themselves carry no role, so nothing is read twice. */}
      <div className="toaster-list" aria-live="polite" aria-relevant="additions text">
        {toasts.map((t) => {
          const Icon = ICONS[t.kind];
          return (
            <div key={t.id} className={cls('toast', `toast-${t.kind}`)}>
              <Icon size={18} className="toast-icon" aria-hidden />
              <span className="toast-message">
                {t.kind === 'error' && <span className="visually-hidden">Error: </span>}
                {t.message}
              </span>
              {t.action && (
                <button
                  type="button"
                  className="toast-action"
                  onClick={() => {
                    t.action?.onClick();
                    dismissToast(t.id);
                  }}
                >
                  {t.action.label}
                </button>
              )}
              <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
                <X size={16} aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}

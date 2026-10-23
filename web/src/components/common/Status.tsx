import { LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

export function Spinner({ label = 'Loading…', size = 20 }: { label?: string; size?: number }) {
  return (
    <span className="spinner" role="status">
      <LoaderCircle size={size} className="spin" aria-hidden />
      <span className="visually-hidden">{label}</span>
    </span>
  );
}

/** Full-area loading state. */
export function LoadingScreen({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="status-screen">
      <Spinner label={label} size={28} />
    </div>
  );
}

/** Full-area error state with a retry button. */
export function ErrorScreen({ title, message, onRetry }: { title: string; message?: ReactNode; onRetry?: () => void }) {
  return (
    <div className="status-screen" role="alert">
      <TriangleAlert size={28} className="status-icon" aria-hidden />
      <h2 className="status-title">{title}</h2>
      {message && <p className="status-message">{message}</p>}
      {onRetry && (
        <button type="button" className="btn btn-primary" onClick={onRetry}>
          <RefreshCw size={16} aria-hidden /> Try again
        </button>
      )}
    </div>
  );
}

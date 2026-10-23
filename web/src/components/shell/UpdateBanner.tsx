import { RefreshCw } from 'lucide-react';
import { useConfig } from '../../api/config';

/** The appVersion of the bundle running in this page (first one the server reported). */
let loadedVersion: string | null = null;

/**
 * Shows "Tower Tracker was updated — Reload" once /api/config reports a different appVersion
 * than the one this page loaded with (config is refetched on focus and every 10 minutes).
 */
export function UpdateBanner() {
  const { data } = useConfig();
  if (data && loadedVersion === null) loadedVersion = data.appVersion; // idempotent
  if (!data || data.appVersion === loadedVersion) return null;

  return (
    <div className="update-banner" role="status">
      <span>Tower Tracker was updated.</span>
      <button type="button" className="btn btn-sm btn-primary" onClick={() => window.location.reload()}>
        <RefreshCw size={14} aria-hidden /> Reload
      </button>
    </div>
  );
}

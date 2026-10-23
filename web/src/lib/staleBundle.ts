// Stale bundle handling. After an update, an open tab still references the old hashed chunks,
// which no longer exist; Vite fires 'vite:preloadError' when a lazy import fails. Reload once to
// pick up the new index.html. A timestamp guard prevents a reload loop if the error persists.

const KEY = 'tt-preload-reload-at';
const MIN_INTERVAL_MS = 30_000;

export function installStaleBundleReload(): void {
  window.addEventListener('vite:preloadError', (event) => {
    let last = 0;
    try {
      last = Number(window.sessionStorage.getItem(KEY) ?? 0);
    } catch {
      /* storage unavailable: still allow one reload */
    }
    if (Date.now() - last < MIN_INTERVAL_MS) return; // already tried; let the error surface
    try {
      window.sessionStorage.setItem(KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
    event.preventDefault();
    window.location.reload();
  });
}

// Unsaved-text drafts (e.g. a card description being edited). Kept in sessionStorage so an
// accidental Back/close doesn't lose the text; falls back to memory when storage is unavailable
// (private mode, blocked site data). Work-log notes use localStorage (`persist`), so a note typed
// at the server survives iOS Safari dropping the tab or the session expiring.

const PREFIX = 'tt-draft:';
const memory = new Map<string, string>();

function store(persist: boolean): Storage {
  return persist ? window.localStorage : window.sessionStorage;
}

export function loadDraft(key: string, persist = false): string | null {
  try {
    const v = store(persist).getItem(PREFIX + key);
    if (v !== null) return v;
  } catch {
    /* storage unavailable */
  }
  return memory.get(key) ?? null;
}

export function saveDraft(key: string, value: string, persist = false): void {
  memory.set(key, value);
  try {
    store(persist).setItem(PREFIX + key, value);
  } catch {
    /* storage unavailable or full: memory copy still works for this page load */
  }
}

export function clearDraft(key: string, persist = false): void {
  memory.delete(key);
  try {
    store(persist).removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}

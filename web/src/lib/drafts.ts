// Unsaved-text drafts (e.g. a card description being edited). Kept in sessionStorage so an
// accidental Back/close doesn't lose the text; falls back to memory when storage is unavailable
// (private mode, blocked site data).

const PREFIX = 'tt-draft:';
const memory = new Map<string, string>();

export function loadDraft(key: string): string | null {
  try {
    const v = window.sessionStorage.getItem(PREFIX + key);
    if (v !== null) return v;
  } catch {
    /* storage unavailable */
  }
  return memory.get(key) ?? null;
}

export function saveDraft(key: string, value: string): void {
  memory.set(key, value);
  try {
    window.sessionStorage.setItem(PREFIX + key, value);
  } catch {
    /* storage unavailable or full: memory copy still works for this page load */
  }
}

export function clearDraft(key: string): void {
  memory.delete(key);
  try {
    window.sessionStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}

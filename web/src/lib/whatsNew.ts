// "What's new" after an update, per device (localStorage):
//  - `tt:whats-new` = 'off' turns the dialog off (Settings → Appearance); on by default.
//  - `tt:last-seen-version` is the Belltower version this device last opened. The first visit
//    only records it: a fresh install has nothing "new" to show.

import { useSyncExternalStore } from 'react';

const PREF_KEY = 'tt:whats-new';
const SEEN_KEY = 'tt:last-seen-version';
const listeners = new Set<() => void>();

function readEnabled(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) !== 'off';
  } catch {
    return true;
  }
}

let enabled = readEnabled();

export function setWhatsNewEnabled(on: boolean): void {
  enabled = on;
  try {
    if (on) localStorage.removeItem(PREF_KEY);
    else localStorage.setItem(PREF_KEY, 'off');
  } catch {
    /* private mode: still applies for this visit */
  }
  for (const l of listeners) l();
}

export function useWhatsNewEnabled(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => enabled,
  );
}

export function readLastSeenVersion(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

export function markVersionSeen(version: string): void {
  try {
    localStorage.setItem(SEEN_KEY, version);
  } catch {
    /* private mode: it shows again next visit, which is harmless */
  }
}

/**
 * Whether to show the dialog for `appVersion` (the running server's). Never for a dev build, on
 * the first visit, for a version already seen, when turned off, or with no notes to show.
 */
export function shouldShowWhatsNew(opts: {
  appVersion: string;
  lastSeen: string | null;
  enabled: boolean;
  hasNotes: boolean;
}): boolean {
  const { appVersion, lastSeen, enabled: on, hasNotes } = opts;
  if (appVersion === 'dev' || lastSeen === null || lastSeen === appVersion) return false;
  return on && hasNotes;
}

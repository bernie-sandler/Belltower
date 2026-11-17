// "What's new" after an update, per device (localStorage):
//  - `tt:whats-new` = 'off' turns the dialog off (Settings → Appearance); on by default.
//  - `tt:last-seen-version` is the Belltower version this device last opened. A device without one
//    has never opened a version with this dialog: it shows the notes only if the install was
//    upgraded (the server's `upgradedFrom`), so a fresh install has nothing "new" to show.

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

/** "1.6.0-rc.2" and "1.6.0 (demo)" → "1.6.0": the version whose CHANGELOG section applies. */
export function releaseOf(appVersion: string): string {
  return appVersion.replace(/ \(demo\)$/, '').replace(/-rc\.\d+$/, '');
}

/**
 * Whether to show the dialog for `appVersion` (the running server's). Never for a dev build, for a
 * version already seen, when turned off, or when the bundled notes are for another version (a
 * release whose CHANGELOG section isn't written yet). On a device with no version of its own, only
 * when the install was upgraded: a fresh install has nothing new to tell.
 */
export function shouldShowWhatsNew(opts: {
  appVersion: string;
  lastSeen: string | null;
  upgradedFrom: string | null;
  enabled: boolean;
  /** The version of the bundled CHANGELOG section, or null with none. */
  notesVersion: string | null;
}): boolean {
  const { appVersion, lastSeen, upgradedFrom, enabled: on, notesVersion } = opts;
  if (appVersion === 'dev' || lastSeen === appVersion) return false;
  if (lastSeen === null && upgradedFrom === null) return false;
  if (notesVersion === null || (notesVersion !== appVersion && notesVersion !== releaseOf(appVersion))) return false;
  return on;
}

// Light / dark / follow the system, remembered per device (localStorage). "System" is pure CSS
// (prefers-color-scheme in tokens.css); a choice sets <html data-theme> and the browser-chrome color.

import { useSyncExternalStore } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'tt:theme';
const HEADER = { light: '#ffffff', dark: '#161a1d' } as const;
const listeners = new Set<() => void>();

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

let current: ThemeChoice = read();
/** A mode shown for now regardless of the choice (the theme editor previews the mode it edits). */
let preview: 'light' | 'dark' | null = null;
/** A custom top-bar color per mode (lib/customTheme.ts), for the browser chrome. */
let headerSource: (mode: 'light' | 'dark') => string | null = () => null;

const header = (mode: 'light' | 'dark') => headerSource(mode) ?? HEADER[mode];

function apply(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const media = meta.getAttribute('media') ?? '';
    const own = media.includes('light') ? header('light') : header('dark');
    meta.content = choice === 'system' ? own : header(choice);
  }
  const scheme = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
  if (scheme) scheme.content = choice === 'system' ? 'dark light' : choice;
}

/** Call once at startup, before the first render. */
export function installTheme(): void {
  apply(current);
  // Another tab changed it.
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    current = read();
    apply(preview ?? current);
    for (const l of listeners) l();
  });
}

export function setTheme(choice: ThemeChoice): void {
  current = choice;
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    /* private mode: still applies for this visit */
  }
  apply(preview ?? choice);
  for (const l of listeners) l();
}

export function setHeaderColorSource(source: (mode: 'light' | 'dark') => string | null): void {
  headerSource = source;
}

/** Re-applies the current choice (after the custom colors change). */
export function refreshTheme(): void {
  apply(preview ?? current);
}

/** Shows `mode` until called again with null, without changing the saved choice. */
export function previewMode(mode: 'light' | 'dark' | null): void {
  preview = mode;
  apply(preview ?? current);
}

/** The mode a choice means right now ("system" asks the device). */
export function resolveMode(choice: ThemeChoice): 'light' | 'dark' {
  if (choice !== 'system') return choice;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** The mode on screen now: a preview, else the choice. */
export function shownMode(): 'light' | 'dark' {
  return preview ?? resolveMode(current);
}

export function useTheme(): ThemeChoice {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

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

function apply(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const media = meta.getAttribute('media') ?? '';
    const own = media.includes('light') ? HEADER.light : HEADER.dark;
    meta.content = choice === 'system' ? own : HEADER[choice];
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
    apply(current);
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
  apply(choice);
  for (const l of listeners) l();
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

// Keeps the demo's data in localStorage, under one namespaced, versioned key. Data saved by an
// older (or newer) version of the demo, or anything that doesn't parse, is dropped and the demo
// seeds itself again, so a change to DemoState can never crash a returning visitor.

import { DEMO_SCHEMA_VERSION, type Ctx, type DemoState } from './server/db';
import { DemoError } from './server/errors';
import type { DemoBackend } from './server/routes';

export const STORAGE_PREFIX = 'belltower-demo:';
export const STORAGE_KEY = `${STORAGE_PREFIX}v${DEMO_SCHEMA_VERSION}`;

export interface DemoStoreOptions {
  storage: Storage;
  /** IANA time zone the demo runs in (the visitor's own). */
  timeZone: string;
  seed: (now: Date, timeZone: string) => DemoState;
  now?: () => Date;
}

const ARRAYS: (keyof DemoState)[] = [
  'columns',
  'labels',
  'cards',
  'checklists',
  'checklistItems',
  'links',
  'activity',
  'revisions',
  'templates',
  'templateRuns',
  'requestTypes',
  'users',
  'watchers',
  'notifications',
];

/** A Storage that only lives in memory, for browsers that block localStorage (the demo then forgets on reload). */
export function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

/** localStorage if the browser lets the page use it, else memoryStorage(). */
export function pickStorage(): Storage {
  try {
    const s = window.localStorage;
    s.setItem(`${STORAGE_PREFIX}probe`, '1');
    s.removeItem(`${STORAGE_PREFIX}probe`);
    return s;
  } catch {
    return memoryStorage();
  }
}

/** Only data this version of the demo wrote is used. */
function looksValid(v: unknown): v is DemoState {
  if (!v || typeof v !== 'object') return false;
  const s = v as Partial<DemoState>;
  return (
    s.version === DEMO_SCHEMA_VERSION &&
    typeof s.ids === 'object' &&
    typeof s.settings === 'object' &&
    typeof s.session === 'object' &&
    ARRAYS.every((k) => Array.isArray(s[k])) &&
    Array.isArray(s.columns) &&
    s.columns.some((c) => c.role === 'triage') &&
    s.columns.some((c) => c.role === 'done') &&
    Array.isArray(s.users) &&
    s.users.some((u) => u.isOwner)
  );
}

export class DemoStore implements DemoBackend {
  private state: DemoState;
  private readonly listeners = new Set<() => void>();
  readonly timeZone: string;
  private readonly storage: Storage;
  private readonly seedFn: DemoStoreOptions['seed'];
  private readonly clock: () => Date;

  constructor(opts: DemoStoreOptions) {
    this.storage = opts.storage;
    this.timeZone = opts.timeZone;
    this.seedFn = opts.seed;
    this.clock = opts.now ?? (() => new Date());
    this.state = this.load();
  }

  private load(): DemoState {
    let saved: unknown = null;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      saved = raw ? JSON.parse(raw) : null;
    } catch {
      saved = null;
    }
    this.dropOtherVersions();
    if (looksValid(saved)) return saved;
    const fresh = this.seedFn(this.clock(), this.timeZone);
    this.write(fresh);
    return fresh;
  }

  /** Old versions' data is never read again, so it shouldn't take up the visitor's storage. */
  private dropOtherVersions(): void {
    try {
      const stale: string[] = [];
      for (let i = 0; i < this.storage.length; i++) {
        const k = this.storage.key(i);
        if (k?.startsWith(STORAGE_PREFIX) && k !== STORAGE_KEY) stale.push(k);
      }
      for (const k of stale) this.storage.removeItem(k);
    } catch {
      // Storage unavailable: nothing to clean.
    }
  }

  /** Returns false when the browser refused (storage full, or blocked). */
  private write(state: DemoState): boolean {
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch {
      return false;
    }
  }

  /** A deep copy of the current data (for tests and the banner). */
  snapshot(): DemoState {
    return structuredClone(this.state);
  }

  signedIn(): boolean {
    return this.state.session.signedIn;
  }

  ctxFor(s: DemoState): Ctx {
    return { s, tz: this.timeZone, now: this.clock };
  }

  /**
   * Runs `fn` on a copy of the data, like a database transaction: if it throws, nothing it changed
   * is kept. With `commit`, the copy is saved and becomes the current data; 'if-changed' (reads
   * that may change something, like the board running due templates) saves only when it did.
   */
  transaction<T>(fn: (ctx: Ctx) => T, commit: boolean | 'if-changed'): T {
    const draft = structuredClone(this.state);
    const result = fn(this.ctxFor(draft));
    if (commit === 'if-changed' && JSON.stringify(draft) === JSON.stringify(this.state)) return result;
    if (commit) {
      if (!this.write(draft)) {
        throw new DemoError(
          507,
          'demo_storage_full',
          'Your browser wouldn’t save the change (its storage for this site may be full). Use “Reset demo data” to start over.',
        );
      }
      this.state = draft;
      this.emit();
    }
    return result;
  }

  setSignedIn(signedIn: boolean): void {
    this.transaction((ctx) => {
      ctx.s.session = { signedIn, userId: signedIn ? (ctx.s.users.find((u) => u.isOwner)?.id ?? null) : null };
    }, true);
  }

  /** Throws everything away and seeds the demo again. */
  reset(): void {
    const fresh = this.seedFn(this.clock(), this.timeZone);
    this.write(fresh);
    this.state = fresh;
    this.emit();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

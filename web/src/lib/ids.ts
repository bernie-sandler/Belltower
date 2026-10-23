// Client-side ids. The app usually runs over plain HTTP (not a secure context), so
// crypto.randomUUID is unavailable; counters and crypto.getRandomValues are used instead.

let tempCounter = 0;

/** A negative id for an optimistic entity that the server hasn't confirmed yet. */
export function tempId(): number {
  tempCounter += 1;
  return -tempCounter;
}

export function isTempId(id: number): boolean {
  return id < 0;
}

/** Short random token (e.g. for DOM ids that must be unique across reloads). */
export function randomToken(bytes = 6): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

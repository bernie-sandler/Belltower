// Wall-clock time in an IANA zone <-> UTC instants, using only Intl (no tz library on the server).

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function dtf(timeZone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(timeZone, f);
  }
  return f;
}

/** Wall-clock parts of an instant in `timeZone`. */
export function zonedParts(ms: number, timeZone: string) {
  const p = Object.fromEntries(dtf(timeZone).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    h: Number(p.hour),
    min: Number(p.minute),
    s: Number(p.second),
  };
}

/** Offset (ms) of `timeZone` from UTC at an instant: local wall time minus UTC. */
function offsetAt(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant at which the wall clock in `timeZone` reads date + time. A time skipped by DST
 * resolves to the instant just after the gap; a repeated time resolves to its first occurrence.
 */
export function zonedToInstant(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [h, min] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, h, min);
  // Two passes settle on the right offset across DST changes; prefer the earlier candidate.
  const a = guess - offsetAt(guess - offsetAt(guess, timeZone), timeZone);
  const b = guess - offsetAt(guess, timeZone);
  const ok = (t: number) => {
    const p = zonedParts(t, timeZone);
    return p.y === y && p.m === m && p.d === d && p.h === h && p.min === min;
  };
  if (ok(a) && ok(b)) return new Date(Math.min(a, b));
  if (ok(a)) return new Date(a);
  if (ok(b)) return new Date(b);
  return new Date(Math.max(a, b)); // in a DST gap
}

/** Start of a local calendar day as an ISO string. */
export function startOfLocalDay(date: string, timeZone: string): string {
  return zonedToInstant(date, '00:00', timeZone).toISOString();
}

/** 'HH:MM' of an instant in `timeZone`. */
export function localTimeOf(iso: string, timeZone: string): string {
  const p = zonedParts(Date.parse(iso), timeZone);
  return `${String(p.h).padStart(2, '0')}:${String(p.min).padStart(2, '0')}`;
}

// Date-only arithmetic on 'YYYY-MM-DD' strings. Deliberately avoids JS local-time Date APIs, which
// shift days under TZ=America/Chicago (DST, UTC parsing). Everything here is pure UTC calendar math.

export interface YMD {
  y: number;
  m: number; // 1-12
  d: number; // 1-31
}

export function parseLocalDate(s: string): YMD {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!match) throw new Error(`Invalid local date "${s}"`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

export function formatLocalDate({ y, m, d }: YMD): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Days since 1970-01-01. */
export function toEpochDay(s: string): number {
  const { y, m, d } = parseLocalDate(s);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

export function fromEpochDay(n: number): string {
  const dt = new Date(n * 86_400_000);
  return formatLocalDate({ y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() });
}

export function addDays(s: string, n: number): string {
  return fromEpochDay(toEpochDay(s) + n);
}

/** Adds months anchored to `anchorDay` (defaults to the date's own day), clamping to month end. */
export function addMonths(s: string, n: number, anchorDay?: number): string {
  const { y, m, d } = parseLocalDate(s);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return formatLocalDate({ y: ny, m: nm, d: Math.min(anchorDay ?? d, daysInMonth(ny, nm)) });
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(s: string): number {
  // 1970-01-01 was a Thursday (4).
  return (((toEpochDay(s) + 4) % 7) + 7) % 7;
}

/** The calendar date of `instant` in `timeZone`. */
export function localDateOf(instant: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    instant,
  );
}

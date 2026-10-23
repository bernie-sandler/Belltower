// Recurrence schedules: every N days, weeks or months from a start date. Pure date-only math on
// 'YYYY-MM-DD' strings (see localdate.ts). Monthly occurrences are always computed from the start
// date, so the day of month never drifts: Jan 31 -> Feb 28 -> Mar 31 -> Apr 30.

import { addDays, addMonths, parseLocalDate, toEpochDay } from './localdate';

export type IntervalUnit = 'day' | 'week' | 'month';

export interface Schedule {
  startDate: string;
  unit: IntervalUnit;
  count: number;
}

/** The k-th occurrence (k = 0 is the start date). */
export function occurrence(s: Schedule, k: number): string {
  if (s.unit === 'day') return addDays(s.startDate, k * s.count);
  if (s.unit === 'week') return addDays(s.startDate, k * s.count * 7);
  return addMonths(s.startDate, k * s.count, parseLocalDate(s.startDate).d);
}

/** Index of the latest occurrence on or before `date`, or -1 if `date` is before the start. */
function latestIndex(s: Schedule, date: string): number {
  if (date < s.startDate) return -1;
  if (s.unit !== 'month') {
    const step = s.count * (s.unit === 'week' ? 7 : 1);
    return Math.floor((toEpochDay(date) - toEpochDay(s.startDate)) / step);
  }
  const a = parseLocalDate(s.startDate);
  const b = parseLocalDate(date);
  let k = Math.floor((b.y * 12 + b.m - (a.y * 12 + a.m)) / s.count);
  while (k > 0 && occurrence(s, k) > date) k--;
  while (occurrence(s, k + 1) <= date) k++;
  return k;
}

/** The latest occurrence on or before `date`, or null before the schedule starts. */
export function latestOnOrBefore(s: Schedule, date: string): string | null {
  const k = latestIndex(s, date);
  return k < 0 ? null : occurrence(s, k);
}

/** The first occurrence strictly after `date`. */
export function firstAfter(s: Schedule, date: string): string {
  return occurrence(s, latestIndex(s, date) + 1);
}

/** The first occurrence on or after `date`. */
export function firstOnOrAfter(s: Schedule, date: string): string {
  const k = latestIndex(s, date);
  if (k >= 0 && occurrence(s, k) === date) return date;
  return occurrence(s, k + 1);
}

/** The next `n` occurrences on or after `date`. */
export function upcoming(s: Schedule, date: string, n: number): string[] {
  const out: string[] = [];
  let k = latestIndex(s, date);
  if (k < 0 || occurrence(s, k) < date) k++;
  while (out.length < n) out.push(occurrence(s, k++));
  return out;
}

/** "Every month", "Every 2 weeks". */
export function describeSchedule(s: Pick<Schedule, 'unit' | 'count'>): string {
  return s.count === 1 ? `Every ${s.unit}` : `Every ${s.count} ${s.unit}s`;
}

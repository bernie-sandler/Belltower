// Time helpers. Everything is displayed in the app time zone (AppConfig.timeZone), not the
// device's. Date-only values ('YYYY-MM-DD') are never passed to `new Date(...)`, which would
// parse them as UTC midnight and shift the day for anyone west of Greenwich.

import { TZDate } from '@date-fns/tz';
import type { CardTile } from '@tt/shared';
import { format } from 'date-fns';
import { useSyncExternalStore } from 'react';

const DAY_MS = 86_400_000;
const SOON_MS = 48 * 60 * 60 * 1000;

let appTimeZone = 'America/Chicago';

/** Set once from /api/config before anything date-related renders. */
export function setAppTimeZone(tz: string): void {
  if (tz) appTimeZone = tz;
}

export function getAppTimeZone(): string {
  return appTimeZone;
}

interface LocalDateParts {
  y: number;
  m: number; // 1-12
  d: number;
}

/** Splits 'YYYY-MM-DD' into numbers without any Date parsing. */
export function parseLocalDate(s: string): LocalDateParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

function parseLocalTime(s: string | null): { h: number; min: number } | null {
  if (!s) return null;
  const match = /^(\d{2}):(\d{2})$/.exec(s);
  if (!match) return null;
  return { h: Number(match[1]), min: Number(match[2]) };
}

/** Days since 1970-01-01 for a local date: pure calendar arithmetic, no time zone involved. */
export function epochDay(s: string): number | null {
  const p = parseLocalDate(s);
  return p ? Math.round(Date.UTC(p.y, p.m - 1, p.d) / DAY_MS) : null;
}

function fromEpochDay(day: number): LocalDateParts {
  const d = new Date(day * DAY_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

/** Today's date in the app time zone, 'YYYY-MM-DD'. */
export function todayLocal(now: number = Date.now(), tz: string = appTimeZone): string {
  return format(new TZDate(now, tz), 'yyyy-MM-dd');
}

/** An instant (UTC ISO string) shown in the app TZ, e.g. "Oct 10, 3:04 PM" (year added if not this year). */
export function formatDateTime(iso: string, now: number = Date.now(), tz: string = appTimeZone): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const d = new TZDate(t, tz);
  const sameYear = d.getFullYear() === new TZDate(now, tz).getFullYear();
  return format(d, sameYear ? 'MMM d, h:mm a' : 'MMM d, yyyy, h:mm a');
}

/** 'HH:MM' (24h) → '3:30 PM'. */
export function formatClock(time: string): string {
  const t = parseLocalTime(time);
  if (!t) return time;
  const suffix = t.h < 12 ? 'AM' : 'PM';
  const h12 = t.h % 12 === 0 ? 12 : t.h % 12;
  return `${h12}:${String(t.min).padStart(2, '0')} ${suffix}`;
}

/**
 * A local date for display: "Oct 12" (or "Oct 12, 2027" outside the current year). With
 * `relative`, nearby days read "Yesterday" / "Today" / "Tomorrow".
 */
export function formatLocalDate(
  dateStr: string,
  opts: { relative?: boolean; now?: number; tz?: string } = {},
): string {
  const p = parseLocalDate(dateStr);
  if (!p) return dateStr;
  const tz = opts.tz ?? appTimeZone;
  const now = opts.now ?? Date.now();
  const today = todayLocal(now, tz);
  if (opts.relative) {
    const diff = (epochDay(dateStr) ?? 0) - (epochDay(today) ?? 0);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
  }
  // Noon keeps us clear of DST transitions, which happen around midnight.
  const d = TZDate.tz(tz, p.y, p.m - 1, p.d, 12, 0);
  const sameYear = today.startsWith(`${p.y}-`);
  return format(d, sameYear ? 'MMM d' : 'MMM d, yyyy');
}

/** Due date (+ optional time) for a tile badge: "Today, 3:30 PM", "Oct 12". */
export function formatDue(
  dueDate: string,
  dueTime: string | null,
  opts: { relative?: boolean; now?: number; tz?: string } = { relative: true },
): string {
  const date = formatLocalDate(dueDate, opts);
  return dueTime ? `${date}, ${formatClock(dueTime)}` : date;
}

/**
 * The instant a due date is missed: the given time, or for an all-day date the start of the
 * next local day in the app TZ.
 */
export function dueDeadline(dueDate: string, dueTime: string | null, tz: string = appTimeZone): number | null {
  const p = parseLocalDate(dueDate);
  if (!p) return null;
  const t = parseLocalTime(dueTime);
  if (t) return TZDate.tz(tz, p.y, p.m - 1, p.d, t.h, t.min).getTime();
  const day = epochDay(dueDate);
  if (day === null) return null;
  const next = fromEpochDay(day + 1);
  return TZDate.tz(tz, next.y, next.m - 1, next.d, 0, 0).getTime();
}

export type DueStatus = 'overdue' | 'soon' | 'upcoming';

/**
 * Badge state for a tile: red when overdue, yellow when the deadline is within 48 hours,
 * neutral otherwise, and no badge at all once the card is completed or has no due date.
 */
export function dueStatus(
  tile: Pick<CardTile, 'dueDate' | 'dueTime' | 'completedAt'>,
  now: number,
  tz: string = appTimeZone,
): DueStatus | null {
  if (!tile.dueDate || tile.completedAt) return null;
  const deadline = dueDeadline(tile.dueDate, tile.dueTime, tz);
  if (deadline === null) return null;
  if (now >= deadline) return 'overdue';
  if (deadline - now <= SOON_MS) return 'soon';
  return 'upcoming';
}

// ---- useNow: one shared minute ticker for every badge on the page ----

let nowValue = Date.now();
const subscribers = new Set<() => void>();
let timer: number | undefined;

function tick(): void {
  nowValue = Date.now();
  for (const fn of subscribers) fn();
}

function scheduleTick(): void {
  // Fire just after each wall-clock minute so "overdue" flips on the minute.
  const delay = 60_000 - (Date.now() % 60_000) + 50;
  timer = window.setTimeout(() => {
    tick();
    scheduleTick();
  }, delay);
}

function onVisibility(): void {
  // Phones suspend timers in the background; catch up as soon as the page is visible again.
  if (document.visibilityState === 'visible') tick();
}

function subscribeNow(fn: () => void): () => void {
  subscribers.add(fn);
  if (subscribers.size === 1) {
    nowValue = Date.now();
    scheduleTick();
    document.addEventListener('visibilitychange', onVisibility);
  }
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0) {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    }
  };
}

/** Current time in ms, re-rendering the caller once a minute (and when the tab becomes visible). */
export function useNow(): number {
  return useSyncExternalStore(subscribeNow, () => nowValue);
}

// ---- <input type="datetime-local"> in the app time zone ----

/** An instant as 'YYYY-MM-DDTHH:mm' wall-clock time in the app TZ (for datetime-local inputs). */
export function toLocalInput(instant: string | number, tz: string = appTimeZone): string {
  const t = typeof instant === 'number' ? instant : Date.parse(instant);
  return format(new TZDate(t, tz), "yyyy-MM-dd'T'HH:mm");
}

/**
 * 'YYYY-MM-DDTHH:mm' read as wall-clock time in the app TZ (not the phone's) → UTC ISO string.
 * A time that occurs twice when DST ends resolves to the first occurrence.
 */
export function fromLocalInput(value: string, tz: string = appTimeZone): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  const t = TZDate.tz(tz, Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** A local date + 'HH:MM' in the app TZ → UTC ISO string. */
export function localDateTimeToIso(date: string, time: string, tz: string = appTimeZone): string | null {
  return fromLocalInput(`${date}T${time}`, tz);
}

/** Compact local timestamp for generated file names, e.g. 20261010-153012. */
export function fileStamp(now: number = Date.now(), tz: string = appTimeZone): string {
  return format(new TZDate(now, tz), 'yyyyMMdd-HHmmss');
}

/** File sizes: 812 B, 14 KB, 3.2 MB. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

// ---- local-date arithmetic for the calendar (pure calendar math, no time zone) ----

export function addLocalDays(date: string, n: number): string {
  const day = epochDay(date);
  if (day === null) return date;
  const p = fromEpochDay(day + n);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(date: string): number {
  const day = epochDay(date) ?? 0;
  return (((day + 4) % 7) + 7) % 7;
}

/** Sunday on or before `date`. */
export function startOfWeek(date: string): string {
  return addLocalDays(date, -weekdayOf(date));
}

export function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function addMonthsLocal(date: string, n: number): string {
  const p = parseLocalDate(date)!;
  const total = p.y * 12 + (p.m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-01`;
}

/** "October 2026". */
export function formatMonth(date: string): string {
  const p = parseLocalDate(date)!;
  return format(new Date(p.y, p.m - 1, 1), 'MMMM yyyy');
}

/** "Mon, Oct 12" for a local date. */
export function formatDayLong(date: string): string {
  const p = parseLocalDate(date)!;
  return format(new Date(p.y, p.m - 1, p.d), 'EEEE, MMM d');
}

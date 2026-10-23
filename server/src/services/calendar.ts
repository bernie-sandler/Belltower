// Calendar: for a range of local days, the cards due, the cards completed (moved to Done), and the
// work logged, each placed on its local day in the app time zone. Archived cards count (the
// calendar is the "what did I do" record); cards in the Trash and retracted work logs don't.

import type { CalendarItem } from '@tt/shared';
import { stmt } from '../db/connection';
import { badRequest } from '../errors';
import { addDays, localDateOf, toEpochDay } from '../lib/localdate';
import { localTimeOf, startOfLocalDay } from '../lib/tz';
import type { Ctx } from './context';

/** A month view shows 6 weeks; allow some slack but keep requests bounded. */
const MAX_DAYS = 100;

interface Row {
  card_id: number;
  title: string;
  priority: CalendarItem['priority'];
  severity: CalendarItem['severity'];
  column_name: string;
  completed_at: string | null;
  archived_at: string | null;
}

const CARD_COLS = `c.id AS card_id, c.title, c.priority, c.severity, col.name AS column_name, c.completed_at, c.archived_at`;

export function calendarItems(ctx: Ctx, from: string, to: string): CalendarItem[] {
  if (toEpochDay(to) - toEpochDay(from) > MAX_DAYS) throw badRequest('validation', `At most ${MAX_DAYS} days at a time`);
  const fromI = startOfLocalDay(from, ctx.tz);
  const toI = startOfLocalDay(addDays(to, 1), ctx.tz);
  const base = (r: Row) => ({
    cardId: r.card_id,
    title: r.title,
    priority: r.priority,
    severity: r.severity,
    columnName: r.column_name,
    completed: r.completed_at !== null,
    archived: r.archived_at !== null,
  });

  const due = (
    stmt(
      ctx.db,
      `SELECT ${CARD_COLS}, c.due_date, c.due_time FROM cards c JOIN columns col ON col.id = c.column_id
        WHERE c.deleted_at IS NULL AND c.due_date >= ? AND c.due_date <= ?`,
    ).all(from, to) as (Row & { due_date: string; due_time: string | null })[]
  ).map((r): CalendarItem => ({ kind: 'due', date: r.due_date, time: r.due_time, ...base(r) }));

  const completed = (
    stmt(
      ctx.db,
      `SELECT ${CARD_COLS} FROM cards c JOIN columns col ON col.id = c.column_id
        WHERE c.deleted_at IS NULL AND c.completed_at >= ? AND c.completed_at < ?`,
    ).all(fromI, toI) as Row[]
  ).map(
    (r): CalendarItem => ({
      kind: 'completed',
      date: localDateOf(new Date(r.completed_at!), ctx.tz),
      time: localTimeOf(r.completed_at!, ctx.tz),
      ...base(r),
    }),
  );

  const worklogs = (
    stmt(
      ctx.db,
      `SELECT ${CARD_COLS}, a.id AS activity_id, a.occurred_at, a.body_md
         FROM activity a JOIN cards c ON c.id = a.card_id JOIN columns col ON col.id = c.column_id
        WHERE a.kind = 'worklog' AND a.retracted_at IS NULL AND c.deleted_at IS NULL
          AND a.occurred_at >= ? AND a.occurred_at < ?`,
    ).all(fromI, toI) as (Row & { activity_id: number; occurred_at: string; body_md: string })[]
  ).map(
    (r): CalendarItem => ({
      kind: 'worklog',
      date: localDateOf(new Date(r.occurred_at), ctx.tz),
      time: localTimeOf(r.occurred_at, ctx.tz),
      activityId: r.activity_id,
      bodyMd: r.body_md,
      ...base(r),
    }),
  );

  const kindOrder = { due: 0, completed: 1, worklog: 2 } as const;
  return [...due, ...completed, ...worklogs].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      kindOrder[a.kind] - kindOrder[b.kind] ||
      (a.time ?? '99:99').localeCompare(b.time ?? '99:99') ||
      a.cardId - b.cardId,
  );
}

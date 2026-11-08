// GET /api/v1/summary: ticket counts for dashboards (Homepage, Home Assistant…). It reuses the rules
// the rest of the app already applies, so the numbers agree with what people see elsewhere:
// ticketState() for received / in progress / waiting (the status page), isUrgent() with the
// notification alert levels, and the daily summary's due-date filter.

import { PRIORITY_CODES, SEVERITY_CODES, type ApiSummary, type Priority, type Severity } from '@tt/shared';
import { stmt } from '../db/connection';
import { addDays, localDateOf, toEpochDay } from '../lib/localdate';
import { startOfLocalDay } from '../lib/tz';
import type { Ctx } from './context';
import { DUE_WHERE, isUrgent } from './notify';
import { getAlertSettings } from './settings';
import { ticketStates } from './ticketState';

interface OpenRow {
  id: number;
  column_id: number;
  completed_at: null;
  priority: Priority | null;
  severity: Severity | null;
  created_at: string;
}

export function apiSummary(ctx: Ctx): ApiSummary {
  const now = ctx.clock.now();
  const today = localDateOf(now, ctx.tz);
  const open = stmt(
    ctx.db,
    `SELECT id, column_id, completed_at, priority, severity, created_at FROM cards
      WHERE kind = 'ticket' AND deleted_at IS NULL AND archived_at IS NULL AND completed_at IS NULL`,
  ).all() as OpenRow[];

  const states = ticketStates(ctx, open);
  const count = (state: string) => states.filter((s) => s === state).length;
  const alerts = getAlertSettings(ctx);
  const byPriority = { P0: 0, P1: 0, P2: 0, P3: 0, none: 0 };
  const bySeverity = { S1: 0, S2: 0, S3: 0, S4: 0, none: 0 };
  let urgent = 0;
  let oldest: string | null = null;
  for (const c of open) {
    byPriority[(c.priority ? PRIORITY_CODES[c.priority] : 'none') as keyof typeof byPriority]++;
    bySeverity[(c.severity ? SEVERITY_CODES[c.severity] : 'none') as keyof typeof bySeverity]++;
    if (isUrgent(alerts, c.priority, c.severity)) urgent++;
    if (oldest === null || c.created_at < oldest) oldest = c.created_at;
  }

  const due = stmt(
    ctx.db,
    `SELECT coalesce(sum(c.due_date < ?), 0) AS overdue, coalesce(sum(c.due_date = ?), 0) AS dueToday FROM cards c WHERE ${DUE_WHERE}`,
  ).get(today, today, today) as { overdue: number; dueToday: number };
  const completedSince = (date: string) =>
    stmt(ctx.db, `SELECT count(*) FROM cards WHERE kind = 'ticket' AND deleted_at IS NULL AND completed_at >= ?`)
      .pluck()
      .get(startOfLocalDay(date, ctx.tz)) as number;

  return {
    open: open.length,
    received: count('received'),
    inProgress: count('in_progress'),
    waiting: count('waiting'),
    urgent,
    overdue: due.overdue,
    dueToday: due.dueToday,
    completedToday: completedSince(today),
    completed7d: completedSince(addDays(today, -6)),
    oldestOpenDays: oldest === null ? null : toEpochDay(today) - toEpochDay(localDateOf(new Date(oldest), ctx.tz)),
    byPriority,
    bySeverity,
    generatedAt: now.toISOString(),
  };
}

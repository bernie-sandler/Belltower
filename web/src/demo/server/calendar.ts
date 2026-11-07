// Mirrors server/src/services/calendar.ts: cards due, cards completed and work logged per local day.

import type { CalendarItem } from '@tt/shared';
import { columnName } from './cardParts';
import type { CardRow, Ctx } from './db';
import { badRequest } from './errors';
import { addDays, localDateOf, localTimeOf, startOfLocalDay, toEpochDay } from './lib';

const MAX_DAYS = 100;

export function calendarItems(ctx: Ctx, from: string, to: string): CalendarItem[] {
  if (toEpochDay(to) - toEpochDay(from) > MAX_DAYS) throw badRequest('validation', `At most ${MAX_DAYS} days at a time`);
  const fromI = startOfLocalDay(from, ctx.tz);
  const toI = startOfLocalDay(addDays(to, 1), ctx.tz);
  const base = (c: CardRow) => ({
    cardId: c.id,
    ticketNo: c.ticketNo,
    title: c.title,
    priority: c.priority,
    severity: c.severity,
    columnName: columnName(ctx, c.columnId),
    completed: c.completedAt !== null,
    archived: c.archivedAt !== null,
  });
  const live = ctx.s.cards.filter((c) => !c.deletedAt);

  const due = live
    .filter((c) => c.dueDate !== null && c.dueDate >= from && c.dueDate <= to)
    .map((c): CalendarItem => ({ kind: 'due', date: c.dueDate!, time: c.dueTime, ...base(c) }));

  const completed = live
    .filter((c) => c.completedAt !== null && c.completedAt >= fromI && c.completedAt < toI)
    .map(
      (c): CalendarItem => ({
        kind: 'completed',
        date: localDateOf(new Date(c.completedAt!), ctx.tz),
        time: localTimeOf(c.completedAt!, ctx.tz),
        ...base(c),
      }),
    );

  const byId = new Map(live.map((c) => [c.id, c]));
  const worklogs = ctx.s.activity
    .filter((a) => a.kind === 'worklog' && !a.retractedAt && byId.has(a.cardId) && a.occurredAt >= fromI && a.occurredAt < toI)
    .map(
      (a): CalendarItem => ({
        kind: 'worklog',
        date: localDateOf(new Date(a.occurredAt), ctx.tz),
        time: localTimeOf(a.occurredAt, ctx.tz),
        activityId: a.id,
        bodyMd: a.bodyMd ?? '',
        ...base(byId.get(a.cardId)!),
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

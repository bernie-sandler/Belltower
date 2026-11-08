import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archiveCard, completeCard, createCard, deleteCard, moveCard } from '../src/services/cards';
import { createLink } from '../src/services/links';
import { updateAlertSettings } from '../src/services/settings';
import { apiSummary } from '../src/services/summary';
import { columnId, makeCtx, T0 } from './helpers';

const EMPTY = {
  open: 0,
  received: 0,
  inProgress: 0,
  waiting: 0,
  urgent: 0,
  overdue: 0,
  dueToday: 0,
  completedToday: 0,
  completed7d: 0,
  oldestOpenDays: null,
  byPriority: { P0: 0, P1: 0, P2: 0, P3: 0, none: 0 },
  bySeverity: { S1: 0, S2: 0, S3: 0, S4: 0, none: 0 },
};

describe('apiSummary', () => {
  let t: ReturnType<typeof makeCtx>;
  beforeEach(() => {
    t = makeCtx();
  });
  afterEach(() => t.close());

  const done = (id: number) => completeCard(t.ctx, id, { includeChildren: false });
  /** The app only archives done cards now, but older versions archived from any column. */
  const archiveOpen = (id: number) => t.ctx.db.prepare('UPDATE cards SET archived_at = ? WHERE id = ?').run(T0, id);

  it('is all zeros on an empty board', () => {
    expect(apiSummary(t.ctx)).toEqual({ ...EMPTY, generatedAt: T0 });
  });

  it('counts open tickets by state, the same way the status page does', () => {
    createCard(t.ctx, { title: 'New request' }); // Triage → received
    createCard(t.ctx, { title: 'Upgrading Plex', columnId: columnId(t.ctx, 'In Progress') });
    createCard(t.ctx, { title: 'Waiting on a part', columnId: columnId(t.ctx, 'Blocked/Waiting') });
    const blocker = createCard(t.ctx, { title: 'Order the cable', columnId: columnId(t.ctx, 'Backlog') });
    const blocked = createCard(t.ctx, { title: 'Swap the cable', columnId: columnId(t.ctx, 'Backlog') });
    createLink(t.ctx, blocker.id, blocked.id, 'blocks');
    // Linking moves it to Blocked/Waiting; moved back out, an open blocker still makes it waiting.
    moveCard(t.ctx, blocked.id, { toColumnId: columnId(t.ctx, 'Backlog'), afterCardId: null });

    // Not counted: work cards, archived or deleted tickets.
    createCard(t.ctx, { title: 'Storage refresh', kind: 'work' });
    archiveOpen(createCard(t.ctx, { title: 'Parked idea' }).id);
    deleteCard(t.ctx, createCard(t.ctx, { title: 'Mistake' }).id);

    expect(apiSummary(t.ctx)).toMatchObject({ open: 5, received: 1, inProgress: 2, waiting: 2 });

    done(blocker.id);
    expect(apiSummary(t.ctx)).toMatchObject({ open: 4, received: 1, inProgress: 2, waiting: 1 });
  });

  it('counts urgent tickets with the notification alert levels, and priorities and severities by code', () => {
    createCard(t.ctx, { title: 'Array offline', priority: 'critical', severity: 'major' });
    createCard(t.ctx, { title: 'Disk failing', priority: 'high' });
    createCard(t.ctx, { title: 'Parity errors', severity: 'blocker' });
    createCard(t.ctx, { title: 'Tidy cables', priority: 'low', severity: 'trivial' });
    createCard(t.ctx, { title: 'No levels' });
    createCard(t.ctx, { title: 'Urgent work card', kind: 'work', priority: 'critical' });
    done(createCard(t.ctx, { title: 'Fixed outage', priority: 'critical' }).id);

    const s = apiSummary(t.ctx);
    expect(s.urgent).toBe(3); // default: P0–P1 or S1
    expect(s.byPriority).toEqual({ P0: 1, P1: 1, P2: 0, P3: 1, none: 2 });
    expect(s.bySeverity).toEqual({ S1: 1, S2: 1, S3: 0, S4: 1, none: 2 });

    updateAlertSettings(t.ctx, { digestTime: '08:00', alertPriority: 'critical', alertSeverity: 'blocker' });
    expect(apiSummary(t.ctx).urgent).toBe(2);
  });

  it('counts due cards like the daily summary, work cards included', () => {
    createCard(t.ctx, { title: 'Renew the domain', dueDate: '2026-10-09' });
    createCard(t.ctx, { title: 'Storage refresh', kind: 'work', dueDate: '2026-10-01' });
    createCard(t.ctx, { title: 'Patch Tuesday', dueDate: '2026-10-10' });
    createCard(t.ctx, { title: 'Next week', dueDate: '2026-10-17' });
    done(createCard(t.ctx, { title: 'Done late', dueDate: '2026-10-02' }).id);
    archiveOpen(createCard(t.ctx, { title: 'Archived', dueDate: '2026-10-02' }).id);

    expect(apiSummary(t.ctx)).toMatchObject({ overdue: 2, dueToday: 1 });
  });

  it('counts completed tickets by local day, archived ones included', () => {
    const at = (iso: string, title: string) => {
      t.clock.set(iso);
      return done(createCard(t.ctx, { title }).id).card;
    };
    at('2026-10-10T05:30:00.000Z', 'Just after midnight in Chicago');
    archiveCard(t.ctx, at('2026-10-10T14:00:00.000Z', 'Archived since').id);
    at('2026-10-10T04:30:00.000Z', 'Friday evening in Chicago');
    at('2026-10-04T06:00:00.000Z', 'Six days ago');
    at('2026-10-03T06:00:00.000Z', 'Seven days ago');
    deleteCard(t.ctx, at('2026-10-10T12:00:00.000Z', 'In the Trash').id);
    done(createCard(t.ctx, { title: 'Work card', kind: 'work' }).id);
    t.clock.set(T0);

    expect(apiSummary(t.ctx)).toMatchObject({ completedToday: 2, completed7d: 4 });
  });

  it('gives the age of the oldest open ticket in local days', () => {
    t.clock.set('2026-10-03T04:00:00.000Z'); // Oct 2, 11 pm in Chicago
    createCard(t.ctx, { title: 'Oldest' });
    t.clock.set('2026-09-01T12:00:00.000Z');
    done(createCard(t.ctx, { title: 'Older but done' }).id);
    t.clock.set(T0);
    createCard(t.ctx, { title: 'Today' });

    expect(apiSummary(t.ctx).oldestOpenDays).toBe(8);
  });
});

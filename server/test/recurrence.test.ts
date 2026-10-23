import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/errors';
import { firstAfter, firstOnOrAfter, latestOnOrBefore, occurrence, upcoming, type Schedule } from '../src/lib/recurrence';
import { zonedToInstant } from '../src/lib/tz';
import { listActivity } from '../src/services/activity';
import { archiveCard, deleteCard, getBoard, getCard, moveCard } from '../src/services/cards';
import {
  createTemplate,
  getTemplate,
  listTemplates,
  runDueTemplates,
  runTemplateNow,
  updateTemplate,
} from '../src/services/recurring';
import { columnId, labelId, makeCtx } from './helpers';

const monthly31: Schedule = { startDate: '2026-01-31', unit: 'month', count: 1 };

describe('schedule math', () => {
  it('clamps month ends without drifting', () => {
    expect([0, 1, 2, 3, 4].map((k) => occurrence(monthly31, k))).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
    ]);
    const leap: Schedule = { startDate: '2028-02-29', unit: 'month', count: 12 };
    expect([0, 1, 4].map((k) => occurrence(leap, k))).toEqual(['2028-02-29', '2029-02-28', '2032-02-29']);
    const quarterly: Schedule = { startDate: '2026-11-30', unit: 'month', count: 3 };
    expect(upcoming(quarterly, '2026-11-01', 3)).toEqual(['2026-11-30', '2027-02-28', '2027-05-30']);
  });

  it('finds occurrences around a date, across DST changes', () => {
    const weekly: Schedule = { startDate: '2026-10-25', unit: 'week', count: 1 }; // DST ends Nov 1
    expect(latestOnOrBefore(weekly, '2026-11-03')).toBe('2026-11-01');
    expect(firstAfter(weekly, '2026-11-01')).toBe('2026-11-08');
    expect(firstOnOrAfter(weekly, '2026-11-01')).toBe('2026-11-01');
    expect(latestOnOrBefore(weekly, '2026-10-24')).toBeNull();
    expect(firstOnOrAfter(weekly, '2026-01-01')).toBe('2026-10-25');
    const daily: Schedule = { startDate: '2026-03-07', unit: 'day', count: 2 }; // DST starts Mar 8
    expect(upcoming(daily, '2026-03-08', 3)).toEqual(['2026-03-09', '2026-03-11', '2026-03-13']);
    expect(latestOnOrBefore(monthly31, '2026-03-30')).toBe('2026-02-28');
    expect(firstAfter(monthly31, '2026-02-28')).toBe('2026-03-31');
  });

  it('turns local wall-clock times into instants in either hemisphere', () => {
    expect(zonedToInstant('2026-10-10', '00:00', 'America/Chicago').toISOString()).toBe('2026-10-10T05:00:00.000Z');
    expect(zonedToInstant('2026-12-10', '00:00', 'America/Chicago').toISOString()).toBe('2026-12-10T06:00:00.000Z');
    expect(zonedToInstant('2026-11-01', '01:30', 'America/Chicago').toISOString()).toBe('2026-11-01T06:30:00.000Z');
    expect(zonedToInstant('2026-03-08', '02:30', 'America/Chicago').toISOString()).toBe('2026-03-08T08:30:00.000Z');
    expect(zonedToInstant('2026-10-10', '00:00', 'Pacific/Auckland').toISOString()).toBe('2026-10-09T11:00:00.000Z');
  });
});

for (const tz of ['America/Chicago', 'Pacific/Auckland']) {
  describe(`scheduler (${tz})`, () => {
    let t: ReturnType<typeof makeCtx>;
    // Local noon on Oct 10 in the zone under test.
    beforeEach(() => {
      t = makeCtx({ tz, now: zonedToInstant('2026-10-10', '12:00', tz).toISOString() });
    });
    afterEach(() => t.close());
    const setLocal = (date: string, time = '00:05') => t.clock.set(zonedToInstant(date, time, tz));
    const fromTemplate = (id: number) => getBoard(t.ctx).cards.filter((c) => getCard(t.ctx, c.id).source === 'recurring' && c.title === getTemplate(t.ctx, id).title);

    function weekly(startDate = '2026-10-11', extra = {}) {
      return createTemplate(t.ctx, {
        title: 'Weekly update check',
        description: 'Check for updates',
        priority: 'low',
        labelIds: [labelId(t.ctx, 'Docker')],
        checklists: [{ title: 'Steps', items: ['Containers', 'Plugins'] }],
        intervalUnit: 'week',
        intervalCount: 1,
        startDate,
        dueInDays: 3,
        enabled: true,
        ...extra,
      });
    }

    it('creates a Triage card on the due day with labels, checklist and due date', () => {
      const tpl = weekly();
      expect(tpl.nextRunDate).toBe('2026-10-11');
      expect(runDueTemplates(t.ctx).created).toEqual([]); // not yet (Oct 10)
      setLocal('2026-10-11');
      const r = runDueTemplates(t.ctx);
      expect(r.created).toHaveLength(1);
      const card = getCard(t.ctx, r.created[0]!);
      expect(card).toMatchObject({
        title: 'Weekly update check',
        columnId: columnId(t.ctx, 'Triage'),
        source: 'recurring',
        priority: 'low',
        dueDate: '2026-10-14',
        checklistTotal: 2,
        labelIds: [labelId(t.ctx, 'Docker')],
      });
      expect(listActivity(t.ctx, card.id)[0]!.data).toMatchObject({ templateTitle: 'Weekly update check' });
      expect(getTemplate(t.ctx, tpl.id)).toMatchObject({ nextRunDate: '2026-10-18', openCardId: card.id });
    });

    it('never duplicates: overlapping ticks make one card, and an open card blocks the next run', () => {
      const tpl = weekly();
      setLocal('2026-10-11');
      expect(runDueTemplates(t.ctx).created).toHaveLength(1);
      expect(runDueTemplates(t.ctx).created).toHaveLength(0); // same day again
      setLocal('2026-10-18');
      const r = runDueTemplates(t.ctx);
      expect(r).toEqual({ created: [], skipped: [tpl.id] });
      const open = getTemplate(t.ctx, tpl.id).openCardId!;
      expect(listActivity(t.ctx, open)[0]).toMatchObject({ type: 'recurrence_skipped', data: { occurrenceDate: '2026-10-18' } });
      expect(fromTemplate(tpl.id)).toHaveLength(1);
    });

    it('makes a new card once the previous one is done, archived or deleted', () => {
      const tpl = weekly();
      setLocal('2026-10-11');
      const first = runDueTemplates(t.ctx).created[0]!;
      moveCard(t.ctx, first, { toColumnId: columnId(t.ctx, 'Done'), afterCardId: null });
      setLocal('2026-10-18');
      const second = runDueTemplates(t.ctx).created[0]!;
      expect(second).toBeDefined();
      deleteCard(t.ctx, second);
      setLocal('2026-10-25');
      const third = runDueTemplates(t.ctx).created[0]!;
      moveCard(t.ctx, third, { toColumnId: columnId(t.ctx, 'Done'), afterCardId: null });
      archiveCard(t.ctx, third);
      setLocal('2026-11-01');
      expect(runDueTemplates(t.ctx).created).toHaveLength(1);
      expect(getTemplate(t.ctx, tpl.id).nextRunDate).toBe('2026-11-08');
    });

    it('after downtime creates one card for the latest missed occurrence, not a burst', () => {
      const tpl = weekly();
      setLocal('2026-11-03'); // missed Oct 11, 18, 25, Nov 1
      const r = runDueTemplates(t.ctx);
      expect(r.created).toHaveLength(1);
      expect(getCard(t.ctx, r.created[0]!).dueDate).toBe('2026-11-04'); // Nov 1 + 3 days
      expect(getTemplate(t.ctx, tpl.id).nextRunDate).toBe('2026-11-08');
    });

    it('pausing stops runs; resuming restarts from today without catch-up', () => {
      const tpl = weekly();
      updateTemplate(t.ctx, tpl.id, { enabled: false });
      setLocal('2026-10-25');
      expect(runDueTemplates(t.ctx).created).toHaveLength(0);
      const resumed = updateTemplate(t.ctx, tpl.id, { enabled: true });
      expect(resumed.nextRunDate).toBe('2026-10-25'); // today is an occurrence
      expect(runDueTemplates(t.ctx).created).toHaveLength(1);
      setLocal('2026-10-27');
      updateTemplate(t.ctx, tpl.id, { enabled: false });
      expect(updateTemplate(t.ctx, tpl.id, { enabled: true }).nextRunDate).toBe('2026-11-01');
    });

    it('"Create now" leaves the schedule alone and counts as the open instance', () => {
      const tpl = weekly('2026-10-12');
      const card = runTemplateNow(t.ctx, tpl.id);
      expect(card.dueDate).toBe('2026-10-13'); // today + 3
      expect(getTemplate(t.ctx, tpl.id)).toMatchObject({ nextRunDate: '2026-10-12', lastRun: { outcome: 'manual' } });
      let err: unknown;
      try {
        runTemplateNow(t.ctx, tpl.id);
      } catch (e) {
        err = e;
      }
      expect((err as AppError).code).toBe('open_instance');
      expect(runTemplateNow(t.ctx, tpl.id, true).id).not.toBe(card.id); // forced
      setLocal('2026-10-12');
      expect(runDueTemplates(t.ctx)).toEqual({ created: [], skipped: [tpl.id] });
    });

    it('changing the schedule recomputes the next run', () => {
      const tpl = weekly();
      const u = updateTemplate(t.ctx, tpl.id, { intervalUnit: 'month', startDate: '2026-01-31' });
      expect(u.nextRunDate).toBe('2026-10-31');
      expect(u.upcoming).toEqual(['2026-10-31', '2026-11-30', '2026-12-31']);
    });

    it('seeded templates start disabled', () => {
      expect(listTemplates(t.ctx).map((x) => x.enabled)).toEqual([false, false, false]);
      setLocal('2027-01-01');
      expect(runDueTemplates(t.ctx).created).toHaveLength(0);
    });
  });
}

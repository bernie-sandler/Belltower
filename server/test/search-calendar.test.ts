import { SearchQuery, type CalendarItem } from '@tt/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { calendarItems } from '../src/services/calendar';
import { archiveCard, createCard, deleteCard, moveCard, updateCard } from '../src/services/cards';
import { addChecklist, addChecklistItem } from '../src/services/checklists';
import { searchCards, toFtsQuery } from '../src/services/search';
import { addWorklog, updateWorklog } from '../src/services/worklog';
import { client, columnId, labelId, makeApp, makeCtx, setupAndLogin } from './helpers';

let t: ReturnType<typeof makeCtx>;
beforeEach(() => {
  t = makeCtx();
});
afterEach(() => t.close());

const search = (q: Record<string, string>) => searchCards(t.ctx, SearchQuery.parse(q));
const ids = (q: Record<string, string>) => search(q).map((r) => r.id);

describe('search', () => {
  it('matches words spread across title, checklists and work logs of one card', () => {
    const a = createCard(t.ctx, { title: 'Parity check October' });
    const listId = addChecklist(t.ctx, a.id, 'Steps').checklists[0]!.id;
    addChecklistItem(t.ctx, listId, 'Check sdb1 for errors');
    addWorklog(t.ctx, a.id, { bodyMd: 'Replaced cable on drive 3' });
    createCard(t.ctx, { title: 'Parity tuning' });
    expect(ids({ q: 'parity sdb1' })).toEqual([a.id]);
    expect(ids({ q: 'parity cable' })).toEqual([a.id]);
    const r = search({ q: 'cable' })[0]!;
    expect(r.matches.map((m) => m.field)).toEqual(['worklogs']);
    expect(r.matches[0]!.snippet).toContain('\u0002cable\u0003');
  });

  it('handles technical tokens and stray punctuation', () => {
    const a = createCard(t.ctx, { title: 'NPM upstream', description: 'Edit nginx.conf; host 10.0.0.5 proxy_pass broken' });
    expect(ids({ q: 'nginx.conf' })).toEqual([a.id]);
    expect(ids({ q: '10.0.0.5' })).toEqual([a.id]);
    expect(ids({ q: 'proxy_pass -' })).toEqual([a.id]);
    expect(ids({ q: 'ngin' })).toEqual([a.id]); // prefix
    expect(toFtsQuery('" - "')).toBeNull();
    expect(ids({ q: '"quoted" OR NOT' })).toEqual([]); // no FTS syntax injection, just words
  });

  it('includes archived cards, excludes the Trash and retracted work logs', () => {
    const done = columnId(t.ctx, 'Done');
    const archived = createCard(t.ctx, { title: 'Old SMART review', columnId: done });
    archiveCard(t.ctx, archived.id);
    const trashed = createCard(t.ctx, { title: 'SMART duplicate' });
    deleteCard(t.ctx, trashed.id);
    expect(ids({ q: 'smart' })).toEqual([archived.id]);
    expect(ids({ q: 'smart', status: 'board' })).toEqual([]);
    expect(ids({ q: 'smart', status: 'archived' })).toEqual([archived.id]);
    const b = createCard(t.ctx, { title: 'B' });
    const w = addWorklog(t.ctx, b.id, { bodyMd: 'zfs scrub results' });
    expect(ids({ q: 'scrub' })).toEqual([b.id]);
    updateWorklog(t.ctx, w.id, { retracted: true });
    expect(ids({ q: 'scrub' })).toEqual([]);
  });

  it('filters by label, priority, severity, column and date range', () => {
    const plex = labelId(t.ctx, 'Plex');
    const a = createCard(t.ctx, { title: 'Plex buffering', labelIds: [plex], priority: 'high', severity: 'major' });
    const b = createCard(t.ctx, { title: 'Plex metadata', priority: 'low' });
    expect(ids({ q: 'plex', labelIds: String(plex) })).toEqual([a.id]);
    expect(ids({ q: 'plex', priorities: 'high,critical' })).toEqual([a.id]);
    expect(ids({ q: 'plex', severities: 'none' })).toEqual([b.id]);
    expect(ids({ q: 'plex', columnIds: String(columnId(t.ctx, 'Backlog')) })).toEqual([]);
    expect(ids({ labelIds: String(plex) })).toEqual([a.id]); // filters only, no text
    // Date range: activity in the range (local days).
    t.clock.set('2026-10-20T15:00:00.000Z');
    addWorklog(t.ctx, b.id, { bodyMd: 'rescanned library' });
    expect(ids({ q: 'plex', from: '2026-10-20', to: '2026-10-20' })).toEqual([b.id]);
    expect(ids({ q: 'plex', to: '2026-10-15' }).sort()).toEqual([a.id, b.id].sort());
  });

  it('returns snippets as plain text with markers, never HTML', async () => {
    const app = await makeApp();
    try {
      const api = client(app.app, await setupAndLogin(app));
      await api('POST', '/api/cards', { title: 'XSS probe', description: '<img src=x onerror=alert(1)> probe text' });
      const res = (await api('GET', '/api/search?q=probe')).json();
      const snippet = res[0].matches.find((m: { field: string }) => m.field === 'description').snippet as string;
      expect(snippet).toContain('<img src=x onerror=alert(1)>'); // raw text; the UI renders it as text
      expect(snippet).toContain('\u0002probe\u0003');
      expect((await api('GET', '/api/search?priorities=urgent')).statusCode).toBe(400);
    } finally {
      await app.shutdown();
    }
  });
});

describe('calendar', () => {
  const kinds = (items: CalendarItem[]) => items.map((i) => `${i.date} ${i.kind} ${i.title}`);

  it('shows due, completed and backdated work on their local days', () => {
    const a = createCard(t.ctx, { title: 'Due card', dueDate: '2026-10-12', dueTime: '18:00' });
    // Completed late in the evening in Chicago = next day in UTC; must land on Oct 10.
    t.clock.set('2026-10-11T03:30:00.000Z');
    const b = createCard(t.ctx, { title: 'Done card' });
    moveCard(t.ctx, b.id, { toColumnId: columnId(t.ctx, 'Done'), afterCardId: null });
    addWorklog(t.ctx, a.id, { bodyMd: 'Backdated work', occurredAt: '2026-10-09T14:00:00.000Z' });
    const items = calendarItems(t.ctx, '2026-10-01', '2026-10-31');
    expect(kinds(items)).toEqual([
      '2026-10-09 worklog Due card',
      '2026-10-10 completed Done card',
      '2026-10-12 due Due card',
    ]);
    expect(items[0]).toMatchObject({ time: '09:00', bodyMd: 'Backdated work' });
    expect(items[1]).toMatchObject({ time: '22:30', completed: true });
    expect(items[2]).toMatchObject({ time: '18:00' });
  });

  it('keeps archived cards, drops the Trash and retracted logs, and respects range edges', () => {
    const done = columnId(t.ctx, 'Done');
    const archived = createCard(t.ctx, { title: 'Archived', columnId: done });
    archiveCard(t.ctx, archived.id);
    const trashed = createCard(t.ctx, { title: 'Trashed', dueDate: '2026-10-10' });
    deleteCard(t.ctx, trashed.id);
    const c = createCard(t.ctx, { title: 'C' });
    const w = addWorklog(t.ctx, c.id, { bodyMd: 'oops' });
    updateWorklog(t.ctx, w.id, { retracted: true });
    expect(kinds(calendarItems(t.ctx, '2026-10-10', '2026-10-10'))).toEqual(['2026-10-10 completed Archived']);
    expect(calendarItems(t.ctx, '2026-10-11', '2026-10-31')).toEqual([]);
  });

  it('moves a completion when the completion date is backdated', () => {
    const card = createCard(t.ctx, { title: 'Fix', columnId: columnId(t.ctx, 'Done') });
    updateCard(t.ctx, card.id, { completedAt: '2026-10-03T16:00:00.000Z' });
    expect(kinds(calendarItems(t.ctx, '2026-10-01', '2026-10-31'))).toEqual(['2026-10-03 completed Fix']);
  });

  it('validates the range over HTTP', async () => {
    const app = await makeApp();
    try {
      const api = client(app.app, await setupAndLogin(app));
      expect((await api('GET', '/api/calendar?from=2026-10-01&to=2026-10-31')).statusCode).toBe(200);
      expect((await api('GET', '/api/calendar?from=2026-10-31&to=2026-10-01')).statusCode).toBe(400);
      expect((await api('GET', '/api/calendar?from=2026-01-01&to=2026-12-31')).statusCode).toBe(400);
    } finally {
      await app.shutdown();
    }
  });
});

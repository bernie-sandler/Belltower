import type { Label, UserInfo } from '@tt/shared';
import { describe, expect, it } from 'vitest';
import { tile } from '../../test/fixtures';
import { assigneeChoices, EMPTY_FILTER, matchesFilter, parseBoardFilter, writeBoardFilter, type BoardFilter } from './FilterBar';

const NONE: BoardFilter = { text: '', labels: [], priorities: [], severities: [], due: [], kinds: [], assignees: [] };
const labels = new Map<number, Label>([[7, { id: 7, name: 'Docker', color: '#4bce97', position: 0 } as Label]]);
const NOW = Date.parse('2026-10-27T15:00:00.000Z');
const match = (t: ReturnType<typeof tile>, f: Partial<BoardFilter>) => matchesFilter(t, { ...NONE, ...f }, labels, NOW);

describe('matchesFilter', () => {
  it('matches everything with no filter', () => {
    expect(match(tile(), {})).toBe(true);
  });

  it('filters by type', () => {
    expect(match(tile({ kind: 'work' }), { kinds: ['work'] })).toBe(true);
    expect(match(tile({ kind: 'ticket' }), { kinds: ['work'] })).toBe(false);
  });

  it('filters by priority and severity, with "none"', () => {
    expect(match(tile({ priority: 'high' }), { priorities: ['high'] })).toBe(true);
    expect(match(tile({ priority: null }), { priorities: ['none'] })).toBe(true);
    expect(match(tile({ priority: 'low' }), { priorities: ['high'] })).toBe(false);
    expect(match(tile({ severity: 'major' }), { severities: ['blocker'] })).toBe(false);
  });

  it('matches text against title, ticket number and label names', () => {
    const t = tile({ title: 'Plex stutters', ticketNo: '261027-9', labelIds: [7] });
    expect(match(t, { text: 'plex' })).toBe(true);
    expect(match(t, { text: '261027-9' })).toBe(true);
    expect(match(t, { text: 'docker plex' })).toBe(true);
    expect(match(t, { text: 'nginx' })).toBe(false);
  });

  it('filters by due state', () => {
    expect(match(tile({ dueDate: '2026-10-20' }), { due: ['overdue'] })).toBe(true);
    expect(match(tile({ dueDate: null }), { due: ['none'] })).toBe(true);
    expect(match(tile({ dueDate: null }), { due: ['has'] })).toBe(false);
  });

  it('filters by assignee: me, nobody, or a person (any of them)', () => {
    const me = 4;
    const byMe = (t: ReturnType<typeof tile>, assignees: string[], meId: number | null = me) =>
      matchesFilter(t, { ...NONE, assignees }, labels, NOW, meId);
    expect(byMe(tile({ assigneeId: 4 }), ['me'])).toBe(true);
    expect(byMe(tile({ assigneeId: 5 }), ['me'])).toBe(false);
    expect(byMe(tile({ assigneeId: null }), ['me'])).toBe(false);
    expect(byMe(tile({ assigneeId: null }), ['me'], null)).toBe(false); // "me" before /api/me loads matches nothing
    expect(byMe(tile({ assigneeId: null }), ['none'])).toBe(true);
    expect(byMe(tile({ assigneeId: 5 }), ['none'])).toBe(false);
    expect(byMe(tile({ assigneeId: 5 }), ['5'])).toBe(true);
    expect(byMe(tile({ assigneeId: 5 }), ['me', 'none'])).toBe(false);
    expect(byMe(tile({ assigneeId: null }), ['me', 'none'])).toBe(true);
    // Groups still combine with AND.
    expect(matchesFilter(tile({ assigneeId: 4, priority: 'low' }), { ...NONE, assignees: ['me'], priorities: ['high'] }, labels, NOW, me)).toBe(false);
  });
});

describe('filter in the URL', () => {
  it('writes assignee=me,none,<id> next to the other filters, and reads it back', () => {
    const f: BoardFilter = { ...EMPTY_FILTER, text: 'plex', labels: [7], priorities: ['high'], assignees: ['me', 'none', '12'] };
    const p = writeBoardFilter(new URLSearchParams('keep=1'), f);
    expect(p.get('assignee')).toBe('me,none,12');
    expect(p.toString()).toBe('keep=1&q=plex&labels=7&prio=high&assignee=me%2Cnone%2C12');
    expect(parseBoardFilter(p)).toEqual(f);
  });

  it('drops empty groups and ignores assignee values it doesn’t understand', () => {
    const p = writeBoardFilter(new URLSearchParams('assignee=me&q=x'), EMPTY_FILTER);
    expect(p.toString()).toBe('');
    expect(parseBoardFilter(new URLSearchParams('assignee=me,,0,abc,-3,7,NONE')).assignees).toEqual(['me', '7']);
  });
});

describe('the Assignee choices', () => {
  const person = (id: number, displayName: string, disabled = false) => ({ id, displayName, disabled }) as UserInfo;
  const users = [person(1, 'Admin'), person(2, 'Alex Chen'), person(3, 'Jordan Lee', true), person(4, 'Kim Park', true)];
  const labelsOf = (assigned: number[], assignees: string[] = []) =>
    assigneeChoices(users, 1, new Set(assigned), { ...EMPTY_FILTER, assignees }).map((c) => c.label);

  it('offers active people besides me, and deactivated people only while they still have cards', () => {
    expect(labelsOf([])).toEqual(['Alex Chen']);
    expect(labelsOf([3])).toEqual(['Alex Chen', 'Jordan Lee (deactivated)']);
  });

  it('keeps anyone already in the filter, so a stale link can be switched off', () => {
    expect(labelsOf([], ['4'])).toEqual(['Alex Chen', 'Kim Park (deactivated)']);
    expect(labelsOf([], ['1'])).toEqual(['Admin', 'Alex Chen']); // me by id, not by "me"
    expect(labelsOf([], ['99'])).toEqual(['Alex Chen', 'Unknown person (#99)']);
    expect(assigneeChoices(undefined, 1, new Set(), { ...EMPTY_FILTER, assignees: ['99'] })).toEqual([]); // not before the directory loads
  });
});

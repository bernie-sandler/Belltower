import type { Label } from '@tt/shared';
import { describe, expect, it } from 'vitest';
import { tile } from '../../test/fixtures';
import { matchesFilter, type BoardFilter } from './FilterBar';

const NONE: BoardFilter = { text: '', labels: [], priorities: [], severities: [], due: [], kinds: [] };
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
});

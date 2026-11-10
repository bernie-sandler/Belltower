import type { ActivityEntry } from '@tt/shared';
import { describe, expect, it } from 'vitest';
import { activityText } from './activityText';

const entry = (type: ActivityEntry['type'], data: Record<string, unknown>): ActivityEntry => ({
  id: 1,
  cardId: 1,
  kind: 'event',
  type,
  data,
  bodyMd: null,
  occurredAt: '2026-10-27T15:00:00.000Z',
  createdAt: '2026-10-27T15:00:00.000Z',
  editedAt: null,
  retractedAt: null,
  revisionCount: 0,
  userId: null,
  tokenId: null,
});

describe('activityText', () => {
  it('describes creation, including work cards and filing', () => {
    expect(activityText(entry('created', { column: { name: 'Triage' } }))).toBe('Created in Triage');
    expect(activityText(entry('created', { column: { name: 'Backlog' }, kind: 'work' }))).toBe('Created as a work card in Backlog');
    expect(activityText(entry('created', { column: { name: 'Triage' }, parent: { ticketNo: '261027-1', title: 'Plex' } }))).toMatch(
      /filed under .*261027-1 — Plex/,
    );
  });

  it('explains automatic and column-deletion moves', () => {
    const blocked = activityText(
      entry('moved', {
        from: { name: 'Triage' },
        to: { name: 'Blocked/Waiting' },
        reason: 'blocked',
        blockedBy: [{ id: 2, title: 'Order part' }],
      }),
    );
    expect(blocked).toMatch(/^Moved from Triage → Blocked\/Waiting: blocked by .*Order part/);
    expect(activityText(entry('moved', { from: { name: 'A' }, to: { name: 'B' }, reason: 'column_deleted' }))).toMatch(/column was deleted/);
  });

  it('describes work-card changes', () => {
    expect(activityText(entry('resolved', { reason: 'Fixed', note: 'New cable', from: null }))).toBe('Resolved: Fixed — ‘New cable’');
    expect(activityText(entry('resolved', { reason: 'Duplicate', note: '', from: 'Fixed' }))).toBe('Resolution changed to Duplicate');
    expect(activityText(entry('resolved', { reason: null, note: '', from: 'Fixed' }))).toBe('Resolution cleared');
    expect(activityText(entry('kind_changed', { from: 'ticket', to: 'work' }))).toBe('Made a work card');
    expect(activityText(entry('parent_changed', { from: null, to: { ticketNo: '261027-1', title: 'Plex' } }))).toMatch(/^Filed under work card/);
    expect(activityText(entry('parent_changed', { from: { title: 'Plex' }, to: null }))).toMatch(/^Taken out of work card/);
    expect(activityText(entry('child_added', { child: { title: 'Back up DB' } }))).toMatch(/^Ticket .*Back up DB.* filed here$/);
  });

  it('describes assignments: to someone, taken by the assignee, and unassigned', () => {
    const by = (userId: number | null, data: Record<string, unknown>) => activityText({ ...entry('assigned', data), userId });
    expect(by(1, { from: null, to: 2, fromName: null, toName: 'Alice' })).toBe('Assigned this to Alice');
    expect(by(2, { from: null, to: 2, fromName: null, toName: 'Alice' })).toBe('Took this');
    expect(by(3, { from: 2, to: 3, fromName: 'Alice', toName: 'Bob' })).toBe('Took this');
    expect(by(1, { from: 2, to: null, fromName: 'Alice', toName: null })).toBe('Unassigned Alice');
    // Changes nobody made (no person on the entry) never read as "took this".
    expect(by(null, { from: null, to: 2, fromName: null, toName: 'Alice' })).toBe('Assigned this to Alice');
    expect(by(1, { from: null, to: 5 })).toBe('Assigned this to someone');
  });

  it('describes checklist marks', () => {
    const item = { checklistId: 1, checklist: 'Checklist', itemId: 2, text: 'Order battery' };
    expect(activityText(entry('checklist_item_checked', item))).toBe('Checked ‘Order battery’');
    expect(activityText(entry('checklist_item_unchecked', item))).toBe('Unchecked ‘Order battery’');
    expect(activityText(entry('checklist_item_marked', { ...item, state: 'failed' }))).toBe('Marked ‘Order battery’ failed');
    expect(activityText(entry('checklist_item_marked', { ...item, state: 'unverified' }))).toBe('Marked ‘Order battery’ unverified');
    expect(activityText(entry('checklist_item_marked', { ...item, state: 'later' }))).toBe('Marked ‘Order battery’');
  });

  it('never throws on unknown or malformed data', () => {
    expect(() => activityText(entry('moved', {}))).not.toThrow();
    expect(() => activityText(entry('child_removed', { child: 'nope' }))).not.toThrow();
  });
});

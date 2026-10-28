import type { TicketDraft } from '@tt/shared';
import { describe, expect, it } from 'vitest';
import { emptyTicket, fromDraft, toCreateBody } from './TicketForm';

describe('ticket form', () => {
  it('builds a minimal body from an empty form', () => {
    expect(toCreateBody({ ...emptyTicket(), title: '  Fix fans ' }, false)).toEqual({
      title: 'Fix fans',
      description: '',
      priority: null,
      severity: null,
      labelIds: [],
      dueDate: null,
      kind: 'ticket',
      aiDrafted: false,
    });
  });

  it('includes column, checklist (without blanks) and the work card', () => {
    const body = toCreateBody(
      { ...emptyTicket(), title: 'T', columnId: 2, checklist: ['a', ' ', 'b'], parentId: 9, dueDate: '2026-11-01' },
      true,
    );
    expect(body).toMatchObject({ columnId: 2, checklist: ['a', 'b'], parentId: 9, dueDate: '2026-11-01', aiDrafted: true });
  });

  it('never sends a parent for a work card', () => {
    expect(toCreateBody({ ...emptyTicket(), title: 'W', kind: 'work', parentId: 9 }, false)).not.toHaveProperty('parentId');
  });

  it('turns a Claude draft into form fields', () => {
    const draft: TicketDraft = {
      title: 'NPM 502',
      description: '### Symptoms',
      impact: 'high',
      urgency: 'medium',
      priority: 'high',
      severity: 'major',
      priorityReason: 'r',
      severityReason: 's',
      labelIds: [3],
      checklist: ['Check upstream'],
      dueDate: null,
      kind: 'ticket',
      kindReason: '',
      parent: { id: 9, ticketNo: '261027-1', title: 'Proxy work' },
      links: [{ direction: 'blocked_by', card: { id: 4, ticketNo: '261027-2', title: 'DNS' }, reason: 'r' }],
    };
    const fields = fromDraft(draft);
    expect(fields).toMatchObject({
      title: 'NPM 502',
      priority: 'high',
      severity: 'major',
      labelIds: [3],
      dueDate: '',
      kind: 'ticket',
      parentId: 9,
    });
    expect(toCreateBody(fields, true)).toMatchObject({ parentId: 9, links: [{ direction: 'blocked_by', cardId: 4 }] });
    // A suggested work card is never filed under another one.
    expect(fromDraft({ ...draft, kind: 'work' }).parentId).toBeNull();
  });
});

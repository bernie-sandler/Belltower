// Tag-restricted accounts on the list and lookup paths: search, similar tickets, calendar, the
// v1 summary, AI draft context, v1 intake, card import and recurring templates.

import { SearchQuery } from '@tt/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { calendarItems } from '../src/services/calendar';
import { importCards } from '../src/services/cardImport';
import { completeCard, createCard } from '../src/services/cards';
import { withActor, type Ctx } from '../src/services/context';
import { draftTicket, draftTickets, type TicketDrafter } from '../src/services/aiDraft';
import { intakeCard } from '../src/services/intake';
import { createLink } from '../src/services/links';
import { createTemplate, deleteTemplate, getTemplate, listTemplates, runTemplateNow, updateTemplate } from '../src/services/recurring';
import { scopeFor } from '../src/services/scope';
import { searchCards, similarCards } from '../src/services/search';
import { apiSummary } from '../src/services/summary';
import { addWorklog } from '../src/services/worklog';
import { labelId, makeCtx, T0 } from './helpers';

let t: ReturnType<typeof makeCtx>;
beforeEach(() => {
  t = makeCtx();
});
afterEach(() => t.close());

let users = 0;
/** A tag-restricted member who sees the cards tagged with one of `labels`. */
function restricted(...labels: string[]): Ctx {
  const db = t.ctx.db;
  users++;
  const userId = Number(
    db
      .prepare("INSERT INTO users (username, display_name, role, tag_scoped, created_at) VALUES (?, ?, 'member', 1, ?)")
      .run(`rita${users}`, `Rita ${users}`, T0).lastInsertRowid,
  );
  for (const l of labels) db.prepare('INSERT INTO user_labels (user_id, label_id) VALUES (?, ?)').run(userId, labelId(t.ctx, l));
  const scope = scopeFor(t.ctx, userId);
  expect(scope).toBeDefined();
  return withActor(t.ctx, { kind: 'user', userId }, scope);
}

const card = (title: string, labels: string[] = [], extra: Parameters<typeof createCard>[1] = { title: '' }) =>
  createCard(t.ctx, { ...extra, title, labelIds: labels.map((l) => labelId(t.ctx, l)) });

const search = (ctx: Ctx, q: Record<string, string>) => searchCards(ctx, SearchQuery.parse(q));

describe('search', () => {
  it('finds only cards carrying one of the person’s tags', () => {
    const seen = card('Parity check slow', ['Array/Storage']);
    card('Parity drive failing', ['Hardware']);
    card('Parity untagged');
    const rita = restricted('Array/Storage');
    expect(search(rita, { q: 'parity' }).map((r) => r.id)).toEqual([seen.id]);
    expect(search(t.ctx, { q: 'parity' })).toHaveLength(3);
    // Filters only (no text) too.
    expect(search(rita, { status: 'board' }).map((r) => r.id)).toEqual([seen.id]);
  });

  it('shows nothing to a restricted account whose tags are gone', () => {
    card('Parity check slow', ['Array/Storage']);
    const nobody = restricted();
    expect(search(nobody, { q: 'parity' })).toEqual([]);
    expect(search(nobody, { status: 'board' })).toEqual([]);
  });

  it('never matches or shows the title of a linked card the person can’t see', () => {
    const seen = card('Cache pool full', ['Array/Storage']);
    const hidden = card('Zanzibar secret migration', ['Hardware']);
    const shared = card('Zanzibar visible notes', ['Array/Storage']);
    createLink(t.ctx, seen.id, hidden.id, 'relates');
    createLink(t.ctx, seen.id, shared.id, 'relates');
    const rita = restricted('Array/Storage');

    // Everyone else still finds a card by the titles of the cards linked to it.
    expect(search(t.ctx, { q: 'secret' }).map((r) => r.id).sort()).toEqual([seen.id, hidden.id].sort());
    expect(search(rita, { q: 'secret' })).toEqual([]);
    expect(search(rita, { q: 'cache secret' })).toEqual([]);

    // A visible linked card's title still counts, and no snippet carries the hidden title.
    const both = search(rita, { q: 'zanzibar' });
    expect(both.map((r) => r.id).sort()).toEqual([seen.id, shared.id].sort());
    expect(JSON.stringify(both)).not.toMatch(/secret/i);

    // Its own history (the ticket number) still matches, with a snippet from its own text.
    const byNo = search(rita, { q: seen.ticketNo! });
    expect(byNo.map((r) => r.id)).toEqual([seen.id]);
    expect(byNo[0]!.matches.find((m) => m.field === 'history')?.snippet).toContain('\u0002');
    expect(JSON.stringify(byNo)).not.toMatch(/secret/i);
  });

  it('keeps the limit for cards checked again', () => {
    const hidden = card('Hidden blocker', ['Hardware']);
    const ids = [1, 2, 3].map((i) => card(`Disk ${i} warning`, ['Array/Storage']).id);
    for (const id of ids) createLink(t.ctx, id, hidden.id, 'relates');
    const rita = restricted('Array/Storage');
    expect(search(rita, { q: 'disk', limit: '2' })).toHaveLength(2);
    expect(search(rita, { q: 'disk' })).toHaveLength(3);
  });
});

describe('similar tickets', () => {
  const fixed = (title: string, labels: string[], extra: Parameters<typeof createCard>[1] = { title: '' }) => {
    const c = card(title, labels, extra);
    completeCard(t.ctx, c.id, { includeChildren: false, resolution: { reason: 'Fixed', note: 'swapped the cable' } });
    return c;
  };

  it('suggests only visible tickets and names only a visible work card', () => {
    const hiddenWork = card('Hidden network rebuild', ['Hardware'], { title: '', kind: 'work' });
    const seen = fixed('Plex buffering on the TV', ['Docker'], { title: '', parentId: hiddenWork.id });
    fixed('Plex buffering in the bedroom', ['Hardware']);
    const rita = restricted('Docker');
    const res = similarCards(rita, { title: 'Plex keeps buffering', description: '' });
    expect(res.map((r) => r.id)).toEqual([seen.id]);
    expect(res[0]!.parent).toBeNull();
    expect(similarCards(t.ctx, { title: 'Plex keeps buffering', description: '' })).toHaveLength(2);
  });

  it('judges common words by the cards the person can see', () => {
    const seen = fixed('Plex transcoding', ['Docker']);
    for (let i = 0; i < 25; i++) card(`Visible chore ${i}`, ['Docker']);
    for (let i = 0; i < 30; i++) card(`Plex hidden ${i}`, ['Hardware']);
    const rita = restricted('Docker');
    // On the whole board "plex" is everywhere, so it says nothing; among Rita's cards it's rare.
    expect(similarCards(t.ctx, { title: 'Plex', description: '' })).toEqual([]);
    expect(similarCards(rita, { title: 'Plex', description: '' }).map((r) => r.id)).toEqual([seen.id]);
  });
});

describe('calendar', () => {
  it('leaves out due dates, completions and work logs of hidden cards', () => {
    const seen = card('Visible due', ['Docker'], { title: '', dueDate: '2026-10-12' });
    const hidden = card('Hidden due', ['Hardware'], { title: '', dueDate: '2026-10-12' });
    addWorklog(t.ctx, hidden.id, { bodyMd: 'hidden work' });
    completeCard(t.ctx, hidden.id, { includeChildren: false });
    addWorklog(t.ctx, seen.id, { bodyMd: 'visible work' });
    const rita = restricted('Docker');
    const items = calendarItems(rita, '2026-10-01', '2026-10-31');
    expect(new Set(items.map((i) => i.cardId))).toEqual(new Set([seen.id]));
    expect(items.map((i) => i.kind).sort()).toEqual(['due', 'worklog']);
    expect(calendarItems(t.ctx, '2026-10-01', '2026-10-31').length).toBeGreaterThan(items.length);
  });
});

describe('v1 summary', () => {
  it('counts only the cards the token’s owner can see', () => {
    card('Visible open', ['Docker'], { title: '', priority: 'critical', dueDate: '2026-10-01' });
    card('Hidden open', ['Hardware'], { title: '', priority: 'critical', dueDate: '2026-10-01' });
    const done = card('Hidden done', ['Hardware']);
    completeCard(t.ctx, done.id, { includeChildren: false });
    const rita = restricted('Docker');
    const s = apiSummary(rita);
    expect(s.open).toBe(1);
    expect(s.byPriority.P0).toBe(1);
    expect(s.overdue).toBe(1);
    expect(s.completedToday).toBe(0);
    expect(apiSummary(t.ctx).open).toBe(2);
    expect(apiSummary(t.ctx).completedToday).toBe(1);
  });
});

describe('AI drafts', () => {
  const drafter = (answer: unknown) => {
    const prompts: string[] = [];
    const d: TicketDrafter = {
      model: 'test',
      complete: async <T,>(_system: string, user: string) => {
        prompts.push(user);
        return answer as T;
      },
    };
    return { d, prompts };
  };

  it('sends and links only visible open cards', async () => {
    const seen = card('Visible work', ['Docker'], { title: '', kind: 'work' });
    const hidden = card('Hidden secret work', ['Hardware'], { title: '', kind: 'work' });
    const rita = restricted('Docker');
    const { d, prompts } = drafter({
      title: 'New',
      description: '',
      impact: 'low',
      urgency: 'low',
      severity: 'minor',
      priorityReason: '',
      severityReason: '',
      labels: [],
      checklist: [],
      dueDate: null,
      kind: 'ticket',
      kindReason: '',
      partOf: hidden.ticketNo,
      links: [
        { type: 'relatedTo', card: hidden.ticketNo, reason: 'x' },
        { type: 'relatedTo', card: seen.ticketNo, reason: 'y' },
      ],
    });
    const draft = await draftTicket(rita, d, 'something broke');
    expect(prompts[0]).toContain('Visible work');
    expect(prompts[0]).not.toContain('Hidden secret work');
    expect(draft.parent).toBeNull();
    expect(draft.links.map((l) => l.card.id)).toEqual([seen.id]);
  });

  it('previews several drafts without resolving hidden cards', async () => {
    const hidden = card('Hidden secret work', ['Hardware'], { title: '', kind: 'work' });
    const rita = restricted('Docker');
    const one = { ref: 'a', type: 'ticket', title: 'New one', description: '', impact: 'low', urgency: 'low', severity: 'minor' };
    const { d, prompts } = drafter({
      cards: [{ ...one, labels: [], checklist: [], dueDate: null, partOf: hidden.ticketNo, blocks: [], blockedBy: [], relatedTo: [] }],
    });
    const res = await draftTickets(rita, d, 'notes');
    expect(prompts[0]).not.toContain('Hidden secret work');
    expect(res.preview.items[0]!.ok).toBe(false);
    expect(JSON.stringify(res)).not.toMatch(/secret/i);
  });
});

describe('card import', () => {
  it('treats a hidden ticket number like one that isn’t on the board', () => {
    const hidden = card('Hidden secret work', ['Hardware'], { title: '', kind: 'work' });
    const seen = card('Visible work', ['Docker'], { title: '', kind: 'work' });
    const rita = restricted('Docker');
    const res = importCards(rita, { cards: [{ title: 'A', partOf: hidden.ticketNo }, { title: 'B', relatedTo: [hidden.ticketNo] }] }, true);
    expect(res.items.map((i) => i.ok)).toEqual([false, false]);
    expect(res.items[0]!.errors[0]).toContain('isn\'t a work card in this import or a ticket number on the board');
    expect(res.items[1]!.errors[0]).toContain('isn\'t a card in this import or a ticket number on the board');
    expect(JSON.stringify(res)).not.toMatch(/secret/i);
    const ok = importCards(rita, { cards: [{ title: 'C', partOf: seen.ticketNo }] }, true);
    expect(ok.items[0]!.card!.parent).toEqual({ id: seen.id, ticketNo: seen.ticketNo, title: 'Visible work' });
    // Everyone else resolves it as before.
    expect(importCards(t.ctx, { cards: [{ title: 'A', partOf: hidden.ticketNo }] }, true).items[0]!.ok).toBe(true);
  });
});

describe('v1 intake', () => {
  it('doesn’t update a hidden open card with the same dedupe key', () => {
    const token = { id: 1, name: 'kuma', canComplete: true, scope: 'full' as const, userId: null };
    const first = intakeCard(t.ctx, token, { title: 'NAS down', labels: ['Hardware'], dedupeKey: 'nas' });
    expect(first.status).toBe('created');
    const rita = restricted('Docker');
    const again = intakeCard(rita, token, { title: 'NAS down', labels: ['Docker'], dedupeKey: 'nas' });
    expect(again.status).toBe('created');
    expect(again.card!.id).not.toBe(first.card!.id);
    // The hidden card got no note.
    const notes = t.ctx.db.prepare("SELECT count(*) FROM activity WHERE card_id = ? AND kind = 'worklog'").pluck().get(first.card!.id);
    expect(notes).toBe(0);
    // A resolve from the restricted token can't reach the hidden card either.
    const resolved = intakeCard(rita, token, { title: 'NAS up', dedupeKey: 'nas', event: 'resolved' });
    expect(resolved.card?.id).toBe(again.card!.id);
  });
});

describe('recurring templates', () => {
  it('lists only templates carrying one of the person’s tags, and hides cards they can’t see', () => {
    // The seeded templates carry Array/Storage, Unraid OS, Hardware and Docker.
    const rita = restricted('Docker');
    const all = listTemplates(t.ctx);
    const mine = listTemplates(rita);
    const docker = labelId(t.ctx, 'Docker');
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.length).toBeLessThan(all.length);
    expect(mine.every((tpl) => tpl.labelIds.includes(docker))).toBe(true);
    const other = all.find((tpl) => !tpl.labelIds.includes(docker))!;
    expect(() => getTemplate(rita, other.id)).toThrow(/not found/i);

    // A card made from a visible template but retagged out of sight stays unnamed.
    const tpl = mine[0]!;
    const made = runTemplateNow(t.ctx, tpl.id);
    expect(getTemplate(rita, tpl.id).openCardId).toBe(made.id);
    t.ctx.db.prepare('DELETE FROM card_labels WHERE card_id = ?').run(made.id);
    const after = getTemplate(rita, tpl.id);
    expect(after.openCardId).toBeNull();
    expect(after.lastRun?.cardId).toBeNull();
    expect(getTemplate(t.ctx, tpl.id).openCardId).toBe(made.id);
  });

  it('refuses changes from a restricted member', () => {
    const rita = restricted('Docker');
    const tpl = listTemplates(rita)[0]!;
    const body = {
      title: 'X',
      description: '',
      priority: null,
      labelIds: [],
      checklists: [],
      intervalUnit: 'week' as const,
      intervalCount: 1,
      startDate: '2026-10-10',
      dueInDays: null,
      enabled: false,
    };
    for (const f of [
      () => createTemplate(rita, body),
      () => updateTemplate(rita, tpl.id, { title: 'Y' }),
      () => deleteTemplate(rita, tpl.id),
      () => runTemplateNow(rita, tpl.id),
    ]) {
      expect(f).toThrow(expect.objectContaining({ code: 'restricted', status: 403 }));
    }
  });
});

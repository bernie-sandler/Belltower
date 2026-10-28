import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { AppError } from '../src/errors';
import { DRAFT_LIMIT } from '../src/http/routes/tickets';
import { listActivity } from '../src/services/activity';
import { mapAnthropicError, type BulkOutput, type DraftOutput, type TicketDrafter } from '../src/services/aiDraft';
import { createCard } from '../src/services/cards';
import { client, columnId, labelId, makeApp, setupAndLogin, type TestApp } from './helpers';

const OUTPUT: DraftOutput = {
  title: '  Parity check   errors on disk 3 ',
  description: '### Symptoms\nSync errors after the monthly check.',
  impact: 'high',
  urgency: 'medium',
  severity: 'major',
  priorityReason: 'Array data could be at risk.',
  severityReason: 'Parity is a core function.',
  labels: ['array/storage', 'Hardware', 'Made Up Label'],
  checklist: ['Check SMART on disk 3', '  ', 'Reseat the SATA cable'],
  dueDate: 'not a date',
  kind: 'ticket',
  kindReason: 'One problem.',
  partOf: null,
  links: [],
};

class FakeDrafter implements TicketDrafter {
  readonly model = 'claude-test';
  calls: { system: string; user: string }[] = [];
  constructor(private result: DraftOutput | BulkOutput | Error = OUTPUT) {}
  async complete<T>(system: string, user: string): Promise<T> {
    this.calls.push({ system, user });
    if (this.result instanceof Error) throw this.result;
    return this.result as T;
  }
}

let t: TestApp;
afterEach(() => t?.shutdown());

async function setup(ai?: TicketDrafter) {
  t = await makeApp({ ai });
  const cookie = await setupAndLogin(t);
  return client(t.app, cookie);
}

describe('Add ticket: AI status', () => {
  it('reports disabled without a drafter and refuses drafts', async () => {
    const c = await setup();
    expect((await c('GET', '/api/ai/status')).json()).toEqual({ enabled: false, model: null });
    const res = await c('POST', '/api/ai/draft', { text: 'disk is clicking' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('ai_disabled');
  });

  it('reports the model when a drafter is configured', async () => {
    const c = await setup(new FakeDrafter());
    expect((await c('GET', '/api/ai/status')).json()).toEqual({ enabled: true, model: 'claude-test' });
  });

  it('reads the API key and model from the environment', () => {
    expect(loadConfig({}).anthropicApiKey).toBeNull();
    expect(loadConfig({}).aiModel).toBe('claude-opus-5-5');
    const cfg = loadConfig({ ANTHROPIC_API_KEY: ' test-key ', ANTHROPIC_MODEL: 'claude-haiku-5-5' });
    expect(cfg.anthropicApiKey).toBe('test-key');
    expect(cfg.aiModel).toBe('claude-haiku-5-5');
  });
});

describe('Add ticket: drafting', () => {
  it('derives priority from impact x urgency and maps labels to existing ones', async () => {
    const fake = new FakeDrafter();
    const c = await setup(fake);
    const res = await c('POST', '/api/ai/draft', { text: 'Parity check found 12 errors on disk 3' });
    expect(res.statusCode).toBe(200);
    const draft = res.json();
    expect(draft).toMatchObject({
      title: 'Parity check errors on disk 3',
      priority: 'high', // high impact x medium urgency = P1
      severity: 'major',
      checklist: ['Check SMART on disk 3', 'Reseat the SATA cable'],
      dueDate: null,
    });
    expect(draft.labelIds.sort()).toEqual([labelId(t.ctx, 'Array/Storage'), labelId(t.ctx, 'Hardware')].sort());

    // The prompt carries the user's text, the real label names and today's date.
    const { user, system } = fake.calls[0]!;
    expect(user).toContain('Parity check found 12 errors on disk 3');
    expect(user).toContain('"Array/Storage"');
    expect(user).toContain('Today is 2026-10-10');
    expect(system).toContain('S1 Blocker');
  });

  it('normalises loosely formatted ratings', async () => {
    const c = await setup(new FakeDrafter({ ...OUTPUT, impact: 'High', urgency: ' HIGH', severity: 'S1' }));
    expect((await c('POST', '/api/ai/draft', { text: 'array offline' })).json()).toMatchObject({
      impact: 'high',
      priority: 'critical',
      severity: 'blocker',
    });
    const odd = new FakeDrafter({ ...OUTPUT, impact: 'huge', urgency: '?', severity: 'S2 Major' });
    await t.shutdown();
    const c2 = await setup(odd);
    expect((await c2('POST', '/api/ai/draft', { text: 'x' })).json()).toMatchObject({
      priority: 'medium', // unknown levels count as medium x medium
      severity: 'major',
    });
  });

  it('keeps a valid due date', async () => {
    const c = await setup(new FakeDrafter({ ...OUTPUT, dueDate: '2026-10-31' }));
    expect((await c('POST', '/api/ai/draft', { text: 'renew the cert by Halloween' })).json().dueDate).toBe('2026-10-31');
  });

  it('validates the text', async () => {
    const c = await setup(new FakeDrafter());
    expect((await c('POST', '/api/ai/draft', { text: '   ' })).statusCode).toBe(400);
    expect((await c('POST', '/api/ai/draft', { text: 'x'.repeat(8001) })).statusCode).toBe(400);
  });

  it('passes drafter errors through as API errors', async () => {
    const c = await setup(new FakeDrafter(new AppError(503, 'ai_unreachable', "Couldn't reach Claude.")));
    const res = await c('POST', '/api/ai/draft', { text: 'nginx 502' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'ai_unreachable' });
  });

  it('limits how many drafts can be made', async () => {
    const c = await setup(new FakeDrafter());
    for (let i = 0; i < DRAFT_LIMIT.max; i++) {
      expect((await c('POST', '/api/ai/draft', { text: `issue ${i}` })).statusCode).toBe(200);
    }
    const res = await c('POST', '/api/ai/draft', { text: 'one more' });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    t.clock.advance(DRAFT_LIMIT.windowMs);
    expect((await c('POST', '/api/ai/draft', { text: 'later' })).statusCode).toBe(200);
  });

  it('needs auth and the CSRF header', async () => {
    t = await makeApp({ ai: new FakeDrafter() });
    await setupAndLogin(t);
    expect((await client(t.app)('GET', '/api/ai/status')).statusCode).toBe(401);
    expect((await client(t.app)('POST', '/api/ai/draft', { text: 'x' })).statusCode).toBe(401);
    expect((await client(t.app)('POST', '/api/tickets', { title: 'x' })).statusCode).toBe(401);
    const noCsrf = await t.app.inject({ method: 'POST', url: '/api/tickets', payload: { title: 'x' } });
    expect(noCsrf.statusCode).toBe(403);
  });
});

describe('Add ticket: type, work card and links', () => {
  it('lists open cards for Claude and keeps only suggestions that point at them', async () => {
    const fake = new FakeDrafter();
    const c = await setup(fake);
    const work = createCard(t.ctx, { title: 'Plex upgrade', kind: 'work' });
    const nas = createCard(t.ctx, { title: 'NAS fan noise' });
    const doneCard = createCard(t.ctx, { title: 'Old thing', columnId: columnId(t.ctx, 'Done') });
    (fake as unknown as { result: DraftOutput }).result = {
      ...OUTPUT,
      kind: 'Ticket',
      partOf: `${work.ticketNo} Plex upgrade`,
      links: [
        { type: 'blockedBy', card: nas.ticketNo!, reason: 'Needs the NAS first.' },
        { type: 'relatedTo', card: doneCard.ticketNo!, reason: 'Done cards are not offered.' },
        { type: 'relatedTo', card: '999999-9', reason: 'Made up.' },
        { type: 'sort of', card: nas.ticketNo!, reason: 'Unknown type.' },
      ],
    };
    const draft = (await c('POST', '/api/ai/draft', { text: 'Plex transcodes stutter' })).json();
    expect(draft).toMatchObject({
      kind: 'ticket',
      parent: { id: work.id, ticketNo: work.ticketNo, title: 'Plex upgrade' },
      links: [{ direction: 'blocked_by', card: { id: nas.id }, reason: 'Needs the NAS first.' }],
    });
    const { user } = fake.calls[0]!;
    expect(user).toContain(`${work.ticketNo} [Triage, work card] Plex upgrade`);
    expect(user).toContain(`${nas.ticketNo} [Triage] NAS fan noise`);
    expect(user).not.toContain('Old thing');
  });

  it('suggests a work card without a parent', async () => {
    const c = await setup(new FakeDrafter({ ...OUTPUT, kind: 'work', kindReason: 'Several steps.', partOf: 'anything' }));
    expect((await c('POST', '/api/ai/draft', { text: 'migrate to ZFS' })).json()).toMatchObject({ kind: 'work', parent: null });
  });

  it('creates the ticket with its links, or not at all', async () => {
    const c = await setup();
    const nas = createCard(t.ctx, { title: 'NAS' });
    const res = await c('POST', '/api/tickets', { title: 'Plex', links: [{ direction: 'blocked_by', cardId: nas.id }] });
    expect(res.statusCode).toBe(201);
    expect(res.json().links).toHaveLength(1);
    const before = (await c('GET', '/api/board')).json().cards.length;
    const bad = await c('POST', '/api/tickets', { title: 'Self', links: [{ direction: 'relates', cardId: 99999 }] });
    expect(bad.statusCode).toBe(404);
    expect((await c('GET', '/api/board')).json().cards.length).toBe(before);
  });
});

describe('Describe several issues', () => {
  const card = (over: Partial<BulkOutput['cards'][number]>): BulkOutput['cards'][number] => ({
    ref: 'a',
    type: 'ticket',
    title: 'Issue',
    description: '### Symptoms',
    impact: 'medium',
    urgency: 'low',
    severity: 'minor',
    labels: [],
    checklist: [],
    dueDate: null,
    partOf: null,
    blocks: [],
    blockedBy: [],
    relatedTo: [],
    ...over,
  });

  it('turns Claude’s cards into an import preview without saving anything', async () => {
    const fake = new FakeDrafter();
    const c2 = await setup(fake);
    const nas2 = createCard(t.ctx, { title: 'NAS' });
    (fake as unknown as { result: BulkOutput }).result = {
      cards: [
        card({ ref: 'w', type: 'work', title: 'Move to 10GbE' }),
        card({ ref: 'a', title: 'Buy a 10GbE switch', partOf: 'w', labels: ['hardware', 'Invented'], checklist: ['Pick one', ' '] }),
        card({ ref: 'b', title: 'Re-cable rack', partOf: 'w', blockedBy: ['a', nas2.ticketNo!], impact: 'high', urgency: 'high', severity: 'S2' }),
      ],
    };
    const before = (await c2('GET', '/api/board')).json().cards.length;
    const res = await c2('POST', '/api/ai/draft-many', { text: 'switch, cables, waiting on the NAS' });
    expect(res.statusCode).toBe(200);
    const { cards, preview } = res.json();
    expect(cards[1]).toMatchObject({ type: 'ticket', partOf: 'w', labels: ['Hardware'], checklist: ['Pick one'], priority: 'low' });
    expect(cards[2]).toMatchObject({ priority: 'critical', severity: 'major', blockedBy: ['a', nas2.ticketNo] });
    expect(preview.items.map((i: { ok: boolean }) => i.ok)).toEqual([true, true, true]);
    expect(preview.items[2].card.parent).toMatchObject({ batchIndex: 0 });
    expect((await c2('GET', '/api/board')).json().cards.length).toBe(before);
    expect(fake.calls[0]!.user).toContain(`${nas2.ticketNo} [Triage] NAS`);

    // Creating them is a normal import of the returned cards.
    const made = await c2('POST', '/api/import/cards', { data: { cards }, dryRun: false });
    expect(made.statusCode).toBe(201);
    expect(made.json().created).toHaveLength(3);
  });

  it('counts as one draft and says so when Claude finds nothing', async () => {
    const c = await setup(new FakeDrafter({ cards: [] }));
    const res = await c('POST', '/api/ai/draft-many', { text: 'all good' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('ai_empty');
  });
});

describe('Add ticket: creating', () => {
  it('creates the card with its checklist and records the Claude draft in history', async () => {
    const c = await setup(new FakeDrafter());
    const res = await c('POST', '/api/tickets', {
      title: 'Parity errors on disk 3',
      description: '### Symptoms',
      columnId: columnId(t.ctx, 'Backlog'),
      labelIds: [labelId(t.ctx, 'Hardware')],
      priority: 'high',
      severity: 'major',
      dueDate: '2026-10-20',
      checklist: ['Check SMART', 'Reseat cable'],
      aiDrafted: true,
    });
    expect(res.statusCode).toBe(201);
    const card = res.json();
    expect(card).toMatchObject({ columnId: columnId(t.ctx, 'Backlog'), priority: 'high', severity: 'major', dueDate: '2026-10-20' });
    expect(card.checklists).toHaveLength(1);
    expect(card.checklists[0].items.map((i: { text: string }) => i.text)).toEqual(['Check SMART', 'Reseat cable']);
    const created = listActivity(t.ctx, card.id).find((e) => e.type === 'created')!;
    expect(created.data).toMatchObject({ via: 'Add ticket (Claude draft)', source: 'manual' });
  });

  it('creates a blank ticket in Triage without a checklist', async () => {
    const c = await setup();
    const card = (await c('POST', '/api/tickets', { title: 'Replace UPS battery' })).json();
    expect(card.columnId).toBe(columnId(t.ctx, 'Triage'));
    expect(card.checklists).toEqual([]);
    expect(listActivity(t.ctx, card.id).find((e) => e.type === 'created')!.data).toMatchObject({ via: 'Add ticket' });
  });

  it('validates the body', async () => {
    const c = await setup();
    expect((await c('POST', '/api/tickets', { title: '' })).statusCode).toBe(400);
    expect((await c('POST', '/api/tickets', { title: 'x', checklist: [''] })).statusCode).toBe(400);
    expect((await c('POST', '/api/tickets', { title: 'x', priority: 'P1' })).statusCode).toBe(400);
  });
});

describe('Claude error mapping', () => {
  const headers = new Headers();
  it.each([
    [new Anthropic.AuthenticationError(401, {}, 'bad key', headers), 502, 'ai_bad_key'],
    [new Anthropic.RateLimitError(429, {}, 'slow down', headers), 503, 'ai_rate_limited'],
    [new Anthropic.APIConnectionError({ message: 'offline' }), 503, 'ai_unreachable'],
    [new Anthropic.APIConnectionTimeoutError(), 503, 'ai_unreachable'],
    [new Anthropic.InternalServerError(529, {}, 'overloaded', headers), 503, 'ai_unavailable'],
    [new Anthropic.BadRequestError(400, {}, 'bad', headers), 502, 'ai_failed'],
    [new Error('boom'), 502, 'ai_failed'],
  ])('%s', (err, status, code) => {
    const mapped = mapAnthropicError(err);
    expect(mapped.status).toBe(status);
    expect(mapped.code).toBe(code);
  });
});

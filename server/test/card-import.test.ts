import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/errors';
import { listActivity } from '../src/services/activity';
import { createCard, getBoard, getCard } from '../src/services/cards';
import { importCards, parseImportText } from '../src/services/cardImport';
import { client, columnId, labelId, makeApp, makeCtx, setupAndLogin } from './helpers';

let t: ReturnType<typeof makeCtx>;
beforeEach(() => {
  t = makeCtx();
});
afterEach(() => t.close());

const AI_OUTPUT = `Here's the card for your tracker:

\`\`\`json
{
  "format": "tower-tracker/cards@1",
  "cards": [
    {
      "title": "Plex transcoder crashes on 4K HDR files",
      "description": "Transcoder exits with **code 1** when tone mapping.\\n\\n- Happens on GPU transcode only",
      "column": "Backlog",
      "labels": ["Plex", "Hardware", "GPU"],
      "priority": "P1",
      "severity": "S2",
      "due": "2026-10-30 18:00",
      "checklists": [{ "title": "Diagnose", "items": ["Check driver version", "Try CPU transcode"] }],
      "worklog": [{ "text": "Noticed during movie night", "at": "2026-10-09 20:15" }]
    }
  ]
}
\`\`\`

Let me know if you want more cards.`;

describe('card import', () => {
  it('turns AI output (with prose and code fences) into a full card', () => {
    const preview = importCards(t.ctx, AI_OUTPUT, true);
    expect(preview.created).toEqual([]);
    expect(preview.items[0]).toMatchObject({
      ok: true,
      warnings: ['New label "GPU" will be created'],
      card: { column: { name: 'Backlog' }, priority: 'high', severity: 'major', dueDate: '2026-10-30', dueTime: '18:00' },
    });

    const result = importCards(t.ctx, AI_OUTPUT, false);
    expect(result.created).toHaveLength(1);
    const card = getCard(t.ctx, result.created[0]!);
    expect(card).toMatchObject({
      title: 'Plex transcoder crashes on 4K HDR files',
      columnId: columnId(t.ctx, 'Backlog'),
      priority: 'high',
      severity: 'major',
      dueDate: '2026-10-30',
      dueTime: '18:00',
      checklistTotal: 2,
    });
    expect(card.labelIds).toEqual(expect.arrayContaining([labelId(t.ctx, 'Plex'), labelId(t.ctx, 'Hardware'), labelId(t.ctx, 'GPU')]));
    const log = listActivity(t.ctx, card.id);
    // 20:15 Chicago (CDT) on Oct 9 = 01:15 UTC on Oct 10.
    expect(log.find((e) => e.kind === 'worklog')).toMatchObject({ bodyMd: 'Noticed during movie night', occurredAt: '2026-10-10T01:15:00.000Z' });
    expect(log.find((e) => e.type === 'created')!.data).toMatchObject({ via: 'card import', source: 'api' });
  });

  it('accepts a bare card, a bare array, and friendly aliases', () => {
    const r = importCards(
      t.ctx,
      [
        { title: 'A', priority: 'critical', severity: 'blocker', labels: 'Docker, Network', checklist: ['one', 'two'] },
        { name: 'B', priority: 3, severity: 4, status: 'in progress', notes: 'just a note' },
      ],
      false,
    );
    expect(r.created).toHaveLength(2);
    const [a, b] = r.created.map((id) => getCard(t.ctx, id));
    expect(a).toMatchObject({ priority: 'critical', severity: 'blocker', checklistTotal: 2, columnId: columnId(t.ctx, 'Triage') });
    expect(b).toMatchObject({ title: 'B', priority: 'low', severity: 'trivial', columnId: columnId(t.ctx, 'In Progress') });
    expect(importCards(t.ctx, { title: 'Solo' }, false).created).toHaveLength(1);
  });

  it('reports every problem and imports nothing if any card is invalid', () => {
    const r = importCards(
      t.ctx,
      { cards: [{ title: 'Fine' }, { description: 'no title' }, { title: 'Bad', priority: 'P9', due: 'next tuesday', column: 'Nope' }] },
      false,
    );
    expect(r.created).toEqual([]);
    expect(r.items.map((i) => i.ok)).toEqual([true, false, false]);
    expect(r.items[1]!.errors).toEqual(['Missing "title"']);
    expect(r.items[2]!.errors).toEqual(['Unknown priority "P9" (use P0, P1, P2 or P3)', '"due" must look like 2026-10-30 or 2026-10-30 18:00 (got "next tuesday")']);
    expect(r.items[2]!.warnings).toEqual(['Column "Nope" doesn\'t exist; using Triage']);
  });

  it('rejects text that isn\'t JSON', () => {
    expect(() => parseImportText('just some words')).toThrow(AppError);
    expect(parseImportText('```\n[{"title":"x"}]\n```')).toEqual([{ title: 'x' }]);
  });

  it('works over HTTP with a preview first', async () => {
    const app = await makeApp();
    try {
      const api = client(app.app, await setupAndLogin(app));
      const preview = await api('POST', '/api/import/cards', { text: AI_OUTPUT });
      expect(preview.statusCode).toBe(200);
      expect(preview.json().created).toEqual([]);
      const done = await api('POST', '/api/import/cards', { text: AI_OUTPUT, dryRun: false });
      expect(done.statusCode).toBe(201);
      expect((await api('GET', '/api/board')).json().cards).toHaveLength(1);
      const bad = await api('POST', '/api/import/cards', { text: '{"cards":[{}]}', dryRun: false });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().result.items[0].errors).toEqual(['Missing "title"']);
    } finally {
      await app.shutdown();
    }
  });
});

describe('card import: work cards and tickets', () => {
  it('creates a work card with nested tickets, which inherit its column', () => {
    const r = importCards(
      t.ctx,
      {
        cards: [
          {
            type: 'work',
            title: 'Plex upgrade',
            column: 'Backlog',
            tickets: [{ title: 'Back up DB' }, { title: 'Test HDR', column: 'In Progress' }],
          },
          { title: 'Unrelated' },
        ],
      },
      false,
    );
    expect(r.items.map((i) => i.label)).toEqual(['1', '1.1', '1.2', '2']);
    expect(r.items[1]!.card!.parent).toMatchObject({ batchIndex: 0, title: 'Plex upgrade' });
    const [w, a, b, other] = r.created.map((id) => getCard(t.ctx, id));
    expect(w).toMatchObject({ kind: 'work', columnId: columnId(t.ctx, 'Backlog') });
    expect(a).toMatchObject({ kind: 'ticket', parentId: w!.id, columnId: columnId(t.ctx, 'Backlog') });
    expect(b).toMatchObject({ parentId: w!.id, columnId: columnId(t.ctx, 'In Progress') });
    expect(other!.parentId).toBeNull();
    expect(getCard(t.ctx, w!.id).children.map((c) => c.title).sort()).toEqual(['Back up DB', 'Test HDR']);
  });

  it('"tickets" alone implies a work card', () => {
    const r = importCards(t.ctx, { title: 'Folder', tickets: [{ title: 'Inside' }] }, false);
    expect(getCard(t.ctx, r.created[0]!).kind).toBe('work');
  });

  it('files tickets with "partOf": a ref or title in the batch, or an existing ticket number', () => {
    const existing = createCard(t.ctx, { title: 'Existing work', kind: 'work' });
    const r = importCards(
      t.ctx,
      [
        { title: 'By ref', partOf: 'nas' }, // refers forward: work cards are created first
        { title: 'By title', partOf: 'nas migration' },
        { title: 'By number', partOf: existing.ticketNo },
        { type: 'work', ref: 'nas', title: 'NAS migration' },
      ],
      false,
    );
    const [byRef, byTitle, byNumber, nas] = r.created.map((id) => getCard(t.ctx, id));
    expect(byRef!.parentId).toBe(nas!.id);
    expect(byTitle!.parentId).toBe(nas!.id);
    expect(byNumber!.parentId).toBe(existing.id);
  });

  it('reports every parent/child mistake and creates nothing', () => {
    const plainTicket = createCard(t.ctx, { title: 'Just a ticket' });
    const r = importCards(
      t.ctx,
      [
        { title: 'Bad type', type: 'epic' },
        { title: 'Unknown parent', partOf: 'nope' },
        { title: 'Parent is a ticket', partOf: plainTicket.ticketNo },
        { type: 'work', title: 'Work in work', partOf: 'x' },
        { type: 'ticket', title: 'Ticket with tickets', tickets: [{ title: 'kid' }] },
        {
          type: 'work',
          title: 'Too deep',
          tickets: [{ title: 'Nested work', type: 'work' }, { title: 'Grandkids', tickets: [{ title: 'g' }] }, { title: 'Both', partOf: 'x' }],
        },
      ],
      false,
    );
    expect(r.created).toEqual([]);
    const errors = Object.fromEntries(r.items.map((i) => [i.label, i.errors.join(' | ')]));
    expect(errors['1']).toMatch(/Unknown type "epic"/);
    expect(errors['2']).toMatch(/isn't a work card in this import/);
    expect(errors['3']).toMatch(/is a ticket, not a work card/);
    expect(errors['4']).toMatch(/can't be "partOf"/);
    expect(errors['5']).toMatch(/Only a work card/);
    expect(errors['6.1']).toMatch(/can't be nested inside another work card/);
    expect(errors['6.2']).toMatch(/one level deep/);
    expect(errors['6.3']).toMatch(/remove "partOf"/);
    expect(getBoard(t.ctx).cards.map((c) => c.title)).not.toContain('Too deep');
  });
});

describe('card import: links', () => {
  it('links cards in the batch and on the board, from either side, once', () => {
    const onBoard = createCard(t.ctx, { title: 'Order new UPS battery' });
    const r = importCards(
      t.ctx,
      [
        { ref: 'swap', title: 'Swap UPS battery', blockedBy: onBoard.ticketNo, relatedTo: ['calibrate'] },
        { ref: 'calibrate', title: 'Calibrate UPS runtime', blockedBy: 'swap' },
        // The same link given on the other card, and a title instead of a ref:
        { title: 'Log the swap', relatedTo: 'Swap UPS battery', blocks: [] },
      ],
      false,
    );
    expect(r.items.every((i) => i.ok)).toBe(true);
    const [swap, calibrate, log] = r.created.map((id) => getCard(t.ctx, id));
    const dirs = (c: typeof swap) => c!.links.map((l) => `${l.direction}:${l.card.title}`).sort();
    expect(dirs(swap)).toEqual([
      'blocked_by:Order new UPS battery',
      'blocks:Calibrate UPS runtime',
      'relates:Calibrate UPS runtime',
      'relates:Log the swap',
    ]);
    expect(dirs(calibrate)).toEqual(['blocked_by:Swap UPS battery', 'relates:Swap UPS battery']);
    expect(dirs(log)).toEqual(['relates:Swap UPS battery']);
    // Blocked cards go to the blocked column, as with links made by hand.
    expect(swap!.columnId).toBe(columnId(t.ctx, 'Blocked/Waiting'));
    expect(r.items[0]!.warnings).toContain('Blocked by an open card, so it will go to Blocked/Waiting');
    expect(listActivity(t.ctx, onBoard.id).some((e) => e.type === 'linked')).toBe(true);
  });

  it('dedupes a link given on both cards', () => {
    const r = importCards(t.ctx, [{ ref: 'a', title: 'A', blocks: 'b' }, { ref: 'b', title: 'B', blockedBy: 'a' }], false);
    const a = getCard(t.ctx, r.created[0]!);
    expect(a.links).toHaveLength(1);
    expect(r.items[1]!.card!.links).toEqual([]);
  });

  it('accepts the other spellings', () => {
    const r = importCards(
      t.ctx,
      [{ ref: 'a', title: 'A' }, { title: 'B', dependsOn: 'a', related: ['a'] }],
      true,
    );
    expect(r.items[1]!.card!.links.map((l) => l.direction)).toEqual(['blocked_by', 'relates']);
  });

  it('reports bad links and creates nothing', () => {
    const doneCard = createCard(t.ctx, { title: 'Finished', columnId: columnId(t.ctx, 'Done') });
    const r = importCards(
      t.ctx,
      [
        { ref: 'me', title: 'Self', relatedTo: 'me' },
        { title: 'Unknown', blocks: 'nope' },
        { ref: 'x', title: 'X', blocks: 'y' },
        { ref: 'y', title: 'Y', blocks: 'x' },
        { title: 'Blocks a done card', blocks: doneCard.ticketNo },
        { title: 'Done but blocked', column: 'Done', blockedBy: 'x' },
        { title: 'Bad value', relatedTo: [{ nope: 1 }] },
      ],
      true,
    );
    const errors = r.items.map((i) => i.errors.join(' | '));
    expect(errors[0]).toMatch(/can't be linked to itself/);
    expect(errors[1]).toMatch(/"blocks": "nope" isn't a card in this import/);
    expect(errors[3]).toMatch(/can't block each other/);
    expect(errors[4]).toMatch(/“Finished” is done, so the open card/);
    expect(errors[5]).toMatch(/“Done but blocked” is done/);
    expect(errors[6]).toMatch(/must list ticket numbers or refs/);
    expect(importCards(t.ctx, [{ ref: 'me', title: 'Self', relatedTo: 'me' }], false).created).toEqual([]);
  });

  it('a done blocker can block a card going into Done', () => {
    const r = importCards(
      t.ctx,
      [
        { ref: 'a', title: 'A', column: 'Done' },
        { title: 'B', column: 'Done', blockedBy: 'a' },
      ],
      false,
    );
    expect(r.created).toHaveLength(2);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/errors';
import { listActivity } from '../src/services/activity';
import { getCard } from '../src/services/cards';
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

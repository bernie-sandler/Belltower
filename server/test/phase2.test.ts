import type { ActivityEntry, CardDetail, CardSummary, TextPreview } from '@tt/shared';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/errors';
import { listActivity } from '../src/services/activity';
import { cardSummary, listCards } from '../src/services/cardParts';
import { archiveAllDone, createCard, deleteCard, getCard, moveCard, updateCard } from '../src/services/cards';
import {
  addChecklist,
  addChecklistItem,
  deleteChecklist,
  reorderChecklistItems,
  updateChecklistItem,
} from '../src/services/checklists';
import { createLink, deleteLink } from '../src/services/links';
import { addWorklog, listRevisions, updateWorklog } from '../src/services/worklog';
import { client, columnId, makeApp, makeCtx, setupAndLogin, type TestApp } from './helpers';

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
  return 'no error';
}

const search = (t: ReturnType<typeof makeCtx>, q: string) =>
  t.ctx.db.prepare(`SELECT rowid FROM card_search WHERE card_search MATCH ?`).pluck().all(`"${q}"*`) as number[];

describe('services', () => {
  let t: ReturnType<typeof makeCtx>;
  beforeEach(() => {
    t = makeCtx();
  });
  afterEach(() => t.close());
  const types = (id: number) => listActivity(t.ctx, id).map((e) => e.type).reverse();

  describe('checklists', () => {
    it('adds lists and items, logs check/uncheck, and shows progress on the tile', () => {
      const card = createCard(t.ctx, { title: 'Parity check' });
      let d = addChecklist(t.ctx, card.id, 'Steps');
      const listId = d.checklists[0]!.id;
      addChecklistItem(t.ctx, listId, 'Confirm no disks are emulated');
      d = addChecklistItem(t.ctx, listId, 'Run the check');
      const [a, b] = d.checklists[0]!.items;
      d = updateChecklistItem(t.ctx, a!.id, { checked: true });
      expect(d.checklistDone).toBe(1);
      expect(d.checklistTotal).toBe(2);
      expect(d.checklists[0]!.items[0]!.checkedAt).toBe('2026-10-10T15:00:00.000Z');
      updateChecklistItem(t.ctx, a!.id, { checked: false });
      updateChecklistItem(t.ctx, b!.id, { text: 'Run the parity check' }); // not logged
      expect(types(card.id)).toEqual([
        'created',
        'checklist_added',
        'checklist_item_checked',
        'checklist_item_unchecked',
      ]);
      expect(listActivity(t.ctx, card.id)[0]!.data).toMatchObject({ checklist: 'Steps', text: 'Confirm no disks are emulated' });
      expect(search(t, 'emulated')).toEqual([card.id]);
    });

    it('reorders items and logs removal of a whole checklist', () => {
      const card = createCard(t.ctx, { title: 'A' });
      const listId = addChecklist(t.ctx, card.id, 'L').checklists[0]!.id;
      for (const text of ['one', 'two', 'three']) addChecklistItem(t.ctx, listId, text);
      const ids = getCard(t.ctx, card.id).checklists[0]!.items.map((i) => i.id);
      const d = reorderChecklistItems(t.ctx, listId, [ids[2]!, ids[0]!, ids[1]!]);
      expect(d.checklists[0]!.items.map((i) => i.text)).toEqual(['three', 'one', 'two']);
      expect(code(() => reorderChecklistItems(t.ctx, listId, [ids[0]!]))).toBe('validation');
      deleteChecklist(t.ctx, listId);
      expect(getCard(t.ctx, card.id).checklistTotal).toBe(0);
      expect(listActivity(t.ctx, card.id)[0]).toMatchObject({ type: 'checklist_removed', data: { title: 'L' } });
    });

    it('refuses changes to a card in the Trash', () => {
      const card = createCard(t.ctx, { title: 'A' });
      deleteCard(t.ctx, card.id);
      expect(code(() => addChecklist(t.ctx, card.id, 'L'))).toBe('card_deleted');
    });
  });

  describe('work log', () => {
    it('adds entries with an optional backdated time but never in the future', () => {
      const card = createCard(t.ctx, { title: 'Drive 3' });
      const now = addWorklog(t.ctx, card.id, { bodyMd: 'Swapped SATA power cable to drive 3' });
      expect(now).toMatchObject({ kind: 'worklog', occurredAt: '2026-10-10T15:00:00.000Z', revisionCount: 0 });
      const past = addWorklog(t.ctx, card.id, { bodyMd: 'Reseated the HBA', occurredAt: '2026-10-08T22:30:00.000Z' });
      expect(past.occurredAt).toBe('2026-10-08T22:30:00.000Z');
      // Effective time decides the order, so the backdated entry sorts before "created".
      expect(listActivity(t.ctx, card.id).map((e) => e.type)).toEqual(['worklog', 'created', 'worklog']);
      expect(code(() => addWorklog(t.ctx, card.id, { bodyMd: 'x', occurredAt: '2026-10-10T16:00:00.000Z' }))).toBe(
        'validation',
      );
      expect(search(t, 'hba')).toEqual([card.id]);
    });

    it('keeps the original text and every edit time', () => {
      const card = createCard(t.ctx, { title: 'A' });
      const e = addWorklog(t.ctx, card.id, { bodyMd: 'Swapped cable' });
      t.clock.advance(60_000);
      updateWorklog(t.ctx, e.id, { bodyMd: 'Swapped SATA cable' });
      t.clock.advance(60_000);
      const latest = updateWorklog(t.ctx, e.id, { bodyMd: 'Swapped SATA power cable', occurredAt: '2026-10-09T12:00:00.000Z' });
      expect(latest).toMatchObject({ bodyMd: 'Swapped SATA power cable', editedAt: '2026-10-10T15:02:00.000Z', revisionCount: 2 });
      expect(listRevisions(t.ctx, e.id)).toEqual([
        expect.objectContaining({ bodyMd: 'Swapped cable', occurredAt: '2026-10-10T15:00:00.000Z', revisedAt: '2026-10-10T15:01:00.000Z' }),
        expect.objectContaining({ bodyMd: 'Swapped SATA cable', revisedAt: '2026-10-10T15:02:00.000Z' }),
      ]);
      // No-op edits don't create revisions.
      expect(updateWorklog(t.ctx, e.id, { bodyMd: 'Swapped SATA power cable' }).revisionCount).toBe(2);
    });

    it('retracts instead of deleting, and retracted text leaves search', () => {
      const card = createCard(t.ctx, { title: 'A' });
      const e = addWorklog(t.ctx, card.id, { bodyMd: 'Wrong card, oops' });
      expect(search(t, 'oops')).toEqual([card.id]);
      const r = updateWorklog(t.ctx, e.id, { retracted: true });
      expect(r.retractedAt).not.toBeNull();
      expect(search(t, 'oops')).toEqual([]);
      expect(listActivity(t.ctx, card.id).some((x) => x.id === e.id)).toBe(true);
      expect(updateWorklog(t.ctx, e.id, { retracted: false }).retractedAt).toBeNull();
    });

    it('only work-log entries can be edited', () => {
      const card = createCard(t.ctx, { title: 'A' });
      const created = listActivity(t.ctx, card.id)[0]!;
      expect(code(() => updateWorklog(t.ctx, created.id, { bodyMd: 'forged' }))).toBe('not_worklog');
    });
  });

  describe('completion date', () => {
    it('can be backdated for a card in Done, with a logged change', () => {
      const card = createCard(t.ctx, { title: 'A' });
      expect(code(() => updateCard(t.ctx, card.id, { completedAt: '2026-10-09T10:00:00.000Z' }))).toBe('not_done');
      moveCard(t.ctx, card.id, { toColumnId: columnId(t.ctx, 'Done'), afterCardId: null });
      const d = updateCard(t.ctx, card.id, { completedAt: '2026-10-09T10:00:00.000Z' });
      expect(d.completedAt).toBe('2026-10-09T10:00:00.000Z');
      expect(listActivity(t.ctx, card.id)[0]).toMatchObject({
        type: 'completion_changed',
        data: { from: '2026-10-10T15:00:00.000Z', to: '2026-10-09T10:00:00.000Z' },
      });
      expect(code(() => updateCard(t.ctx, card.id, { completedAt: '2026-10-11T10:00:00.000Z' }))).toBe('validation');
    });
  });

  describe('links', () => {
    it('shows related and blocking links from both sides and logs both cards', () => {
      const a = createCard(t.ctx, { title: 'NPM cert renewal failing' });
      const b = createCard(t.ctx, { title: 'Open port 80' });
      const c = createCard(t.ctx, { title: 'Plex remote access' });
      createLink(t.ctx, a.id, b.id, 'blocked_by');
      const d = createLink(t.ctx, a.id, c.id, 'relates');
      expect(d.links.map((l) => [l.direction, l.card.title])).toEqual([
        ['blocked_by', 'Open port 80'],
        ['relates', 'Plex remote access'],
      ]);
      expect(getCard(t.ctx, b.id).links).toMatchObject([{ direction: 'blocks', card: { title: 'NPM cert renewal failing' } }]);
      expect(getCard(t.ctx, c.id).links).toMatchObject([{ direction: 'relates' }]);
      expect(getCard(t.ctx, a.id).linkCount).toBe(2);
      expect(listActivity(t.ctx, b.id)[0]).toMatchObject({
        type: 'linked',
        data: { direction: 'blocks', otherTitle: 'NPM cert renewal failing' },
      });
      // Linked titles are searchable from the other card.
      expect(search(t, 'plex')).toEqual(expect.arrayContaining([a.id, c.id]));
    });

    it('rejects self, duplicate and contradictory links', () => {
      const a = createCard(t.ctx, { title: 'A' });
      const b = createCard(t.ctx, { title: 'B' });
      expect(code(() => createLink(t.ctx, a.id, a.id, 'relates'))).toBe('validation');
      createLink(t.ctx, a.id, b.id, 'relates');
      expect(code(() => createLink(t.ctx, b.id, a.id, 'relates'))).toBe('duplicate_link');
      createLink(t.ctx, a.id, b.id, 'blocks');
      expect(code(() => createLink(t.ctx, b.id, a.id, 'blocks'))).toBe('duplicate_link');
    });

    it('unlinks with an entry on both cards and hides links to trashed cards', () => {
      const a = createCard(t.ctx, { title: 'A' });
      const b = createCard(t.ctx, { title: 'B' });
      const c = createCard(t.ctx, { title: 'C' });
      const linkId = createLink(t.ctx, a.id, b.id, 'blocks').links[0]!.id;
      createLink(t.ctx, a.id, c.id, 'relates');
      deleteLink(t.ctx, b.id, linkId);
      expect(listActivity(t.ctx, a.id)[0]).toMatchObject({ type: 'unlinked', data: { direction: 'blocks', otherTitle: 'B' } });
      deleteCard(t.ctx, c.id);
      expect(getCard(t.ctx, a.id).links).toEqual([]);
      expect(getCard(t.ctx, a.id).linkCount).toBe(0);
    });
  });

  describe('card lists', () => {
    it('lists the Archive and Trash and finds cards by title or #id', () => {
      const done = columnId(t.ctx, 'Done');
      const a = createCard(t.ctx, { title: 'Parity check October', columnId: done });
      const b = createCard(t.ctx, { title: 'Parity check November', columnId: done });
      const c = createCard(t.ctx, { title: '50% done_ish' });
      expect(archiveAllDone(t.ctx)).toBe(2);
      deleteCard(t.ctx, c.id);
      expect(listCards(t.ctx, { status: 'archived', limit: 50 }).map((x) => x.id).sort()).toEqual([a.id, b.id]);
      expect(listCards(t.ctx, { status: 'trashed', limit: 50 }).map((x) => x.id)).toEqual([c.id]);
      expect(listCards(t.ctx, { status: 'live', q: 'november', limit: 50 }).map((x) => x.id)).toEqual([b.id]);
      expect(listCards(t.ctx, { status: 'live', q: `#${a.id}`, limit: 50 }).map((x) => x.id)).toEqual([a.id]);
      // LIKE wildcards in the query are literal.
      expect(listCards(t.ctx, { status: 'trashed', q: '50%', limit: 50 }).map((x) => x.id)).toEqual([c.id]);
      expect(listCards(t.ctx, { status: 'trashed', q: 'o_e', limit: 50 })).toEqual([]);
      expect(cardSummary(t.ctx, a.id)).toMatchObject({ columnName: 'Done' });
    });
  });
});

// ---------------------------------------------------------------------------------------------

function multipart(files: { filename: string; content: Buffer; type?: string }[]) {
  const boundary = '----tt' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const f of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.filename}"\r\n` +
          `Content-Type: ${f.type ?? 'application/octet-stream'}\r\n\r\n`,
      ),
      f.content,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

describe('attachments over HTTP', () => {
  let t: TestApp | undefined;
  afterEach(async () => {
    await t?.shutdown();
    t = undefined;
  });

  async function setup(env: Record<string, string> = {}) {
    t = await makeApp({ env });
    const cookie = await setupAndLogin(t);
    const api = client(t.app, cookie);
    const card = (await api('POST', '/api/cards', { title: 'Syslog errors' })).json() as CardDetail;
    const upload = (files: Parameters<typeof multipart>[0]) => {
      const m = multipart(files);
      return t!.app.inject({
        method: 'POST',
        url: `/api/cards/${card.id}/attachments`,
        headers: { ...m.headers, cookie, 'x-requested-with': 'tower-tracker' },
        payload: m.payload,
      });
    };
    return { api, card, upload, cookie };
  }

  it('detects the kind from content, not the browser, and serves each kind safely', async () => {
    const { api, card, upload } = await setup();
    const res = await upload([
      { filename: 'screenshot-20261010-150000.png', content: PNG, type: 'text/html' },
      { filename: 'syslog.log', content: Buffer.from('line 1\nline 2\n'), type: 'application/octet-stream' },
      { filename: 'evil.html', content: Buffer.from('<script>alert(1)</script>'), type: 'text/html' },
      { filename: 'résumé ✓.txt', content: Buffer.from('ok') },
    ]);
    expect(res.statusCode).toBe(200);
    const d = res.json() as CardDetail;
    expect(d.attachments.map((a) => [a.name, a.kind, a.mimeType])).toEqual([
      ['screenshot-20261010-150000.png', 'image', 'image/png'],
      ['syslog.log', 'text', 'text/plain'],
      ['evil.html', 'file', 'application/octet-stream'],
      ['résumé ✓.txt', 'text', 'text/plain'],
    ]);
    expect(d.attachmentCount).toBe(4);

    const [png, log, html, unicode] = d.attachments;
    const img = await api('GET', `/api/attachments/${png!.id}`);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['content-disposition']).toMatch(/^inline/);
    expect(img.headers['content-security-policy']).toContain('sandbox');
    expect(img.rawPayload.equals(PNG)).toBe(true);

    const evil = await api('GET', `/api/attachments/${html!.id}`);
    expect(evil.headers['content-type']).toBe('application/octet-stream');
    expect(evil.headers['content-disposition']).toMatch(/^attachment/);
    expect(evil.headers['x-content-type-options']).toBe('nosniff');

    expect((await api('GET', `/api/attachments/${log!.id}`)).headers['content-type']).toBe('text/plain; charset=utf-8');
    expect((await api('GET', `/api/attachments/${unicode!.id}`)).headers['content-disposition']).toContain("filename*=UTF-8''");

    // Stored by uuid only, under the card's folder.
    const stored = readdirSync(path.join(t!.dir, 'attachments', String(card.id)));
    expect(stored).toHaveLength(4);
    for (const f of stored) expect(f).toMatch(/^[0-9a-f-]{36}$/);

    expect(listActivity(t!.ctx, card.id).filter((e) => e.type === 'attachment_added')).toHaveLength(4);
  });

  it('previews the head or tail of a large log', async () => {
    const { api, upload } = await setup();
    const lines = Array.from({ length: 30000 }, (_, i) => `2026-10-10 line ${i}`).join('\n') + '\n';
    const d = (await upload([{ filename: 'big.log', content: Buffer.from(lines) }])).json() as CardDetail;
    const id = d.attachments[0]!.id;
    const head = (await api('GET', `/api/attachments/${id}/text?mode=head`)).json() as TextPreview;
    expect(head).toMatchObject({ mode: 'head', truncated: true, totalBytes: Buffer.byteLength(lines) });
    expect(head.text.startsWith('2026-10-10 line 0\n')).toBe(true);
    expect(head.text.endsWith('\n')).toBe(true);
    const tail = (await api('GET', `/api/attachments/${id}/text?mode=tail`)).json() as TextPreview;
    expect(tail.text.endsWith('line 29999\n')).toBe(true);
    expect(tail.text.startsWith('2026-10-10 line ')).toBe(true);
    const full = (await api('GET', `/api/attachments/${id}/text?mode=full`)).json() as TextPreview;
    expect(full.text).toBe(lines);
    const png = (await upload([{ filename: 'x.png', content: PNG }])).json() as CardDetail;
    expect((await api('GET', `/api/attachments/${png.attachments[1]!.id}/text`)).statusCode).toBe(415);
  });

  it('rejects files over the limit and leaves nothing behind', async () => {
    const { upload, card } = await setup({ MAX_UPLOAD_MB: '1' });
    const res = await upload([{ filename: 'huge.log', content: Buffer.alloc(1024 * 1024 + 10, 97) }]);
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: 'too_large' });
    expect(readdirSync(path.join(t!.dir, 'tmp'))).toEqual([]);
    expect(existsSync(path.join(t!.dir, 'attachments', String(card.id)))).toBe(false);
    expect(getCard(t!.ctx, card.id).attachments).toEqual([]);
  });

  it('deletes the file but keeps its name in the history', async () => {
    const { api, card, upload } = await setup();
    const d = (await upload([{ filename: 'nginx.conf', content: Buffer.from('server {}') }])).json() as CardDetail;
    const after = (await api('DELETE', `/api/attachments/${d.attachments[0]!.id}`)).json() as CardDetail;
    expect(after.attachments).toEqual([]);
    expect(readdirSync(path.join(t!.dir, 'attachments', String(card.id)))).toEqual([]);
    const log = (await api('GET', `/api/cards/${card.id}/activity`)).json() as ActivityEntry[];
    expect(log[0]).toMatchObject({ type: 'attachment_removed', data: { name: 'nginx.conf' } });
  });

  it('requires the CSRF header and a session to upload', async () => {
    const { card } = await setup();
    const m = multipart([{ filename: 'a.txt', content: Buffer.from('x') }]);
    const res = await t!.app.inject({ method: 'POST', url: `/api/cards/${card.id}/attachments`, headers: m.headers, payload: m.payload });
    expect(res.statusCode).toBe(403);
  });
});

describe('Phase 2 routes', () => {
  let t: TestApp | undefined;
  afterEach(async () => {
    await t?.shutdown();
    t = undefined;
  });

  it('runs checklists, links, the work log and card lists end to end', async () => {
    t = await makeApp();
    const api = client(t.app, await setupAndLogin(t));
    const a = (await api('POST', '/api/cards', { title: 'A' })).json() as CardDetail;
    const b = (await api('POST', '/api/cards', { title: 'B' })).json() as CardDetail;

    let d = (await api('POST', `/api/cards/${a.id}/checklists`, { title: 'Steps' })).json() as CardDetail;
    d = (await api('POST', `/api/checklists/${d.checklists[0]!.id}/items`, { text: 'Do it' })).json() as CardDetail;
    d = (await api('PATCH', `/api/checklist-items/${d.checklists[0]!.items[0]!.id}`, { checked: true })).json() as CardDetail;
    expect([d.checklistDone, d.checklistTotal]).toEqual([1, 1]);

    d = (await api('POST', `/api/cards/${a.id}/links`, { otherCardId: b.id, direction: 'blocks' })).json() as CardDetail;
    expect(d.links[0]).toMatchObject({ direction: 'blocks', card: { id: b.id } });
    expect((await api('POST', `/api/cards/${a.id}/links`, { otherCardId: b.id, direction: 'blocks' })).statusCode).toBe(409);
    d = (await api('DELETE', `/api/cards/${a.id}/links/${d.links[0]!.id}`)).json() as CardDetail;
    expect(d.links).toEqual([]);

    const w = await api('POST', `/api/cards/${a.id}/worklog`, { bodyMd: 'Did **it**' });
    expect(w.statusCode).toBe(201);
    const entry = w.json() as ActivityEntry;
    const edited = (await api('PATCH', `/api/activity/${entry.id}`, { bodyMd: 'Did it twice' })).json() as ActivityEntry;
    expect(edited.revisionCount).toBe(1);
    expect(((await api('GET', `/api/activity/${entry.id}/revisions`)).json() as unknown[]).length).toBe(1);

    const live = (await api('GET', '/api/cards?status=live&q=b')).json() as CardSummary[];
    expect(live.map((c) => c.id)).toEqual([b.id]);
    expect((await api('GET', '/api/cards?status=nope')).statusCode).toBe(400);
  });
});

import { similarityTerms, stemWord, stripSubmitScaffolding, stripTypePrefix } from '@tt/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archiveCard, completeCard, createCard, deleteCard } from '../src/services/cards';
import { createLink } from '../src/services/links';
import { similarCards } from '../src/services/search';
import { client, makeApp, makeCtx, setupAndLogin, type TestApp } from './helpers';

let t: ReturnType<typeof makeCtx>;
beforeEach(() => {
  t = makeCtx();
});
afterEach(() => t.close());

/** A finished ticket with a resolution. */
function fixed(title: string, note = '', description = '') {
  const card = createCard(t.ctx, { title, description });
  completeCard(t.ctx, card.id, { includeChildren: false, resolution: { reason: 'Fixed', note } });
  return card;
}

const similar = (title: string, description = '', excludeId?: number) =>
  similarCards(t.ctx, { title, description, excludeId }).map((s) => s.title);

describe('picking the words', () => {
  it('keeps distinctive words, stemmed, and drops common ones and ticket numbers', () => {
    expect(similarityTerms('Plex keeps buffering on the TV again (261108-1)')).toEqual(['plex', 'buffer']);
    expect(similarityTerms('nginx.conf returns 502 after the update')).toEqual(['nginx', 'conf', 'return', '502', 'update']);
  });

  it('counts forms of one word once', () => {
    expect(similarityTerms('Check plugin updates, then update the plugins')).toEqual(['check', 'plugin', 'updat']);
  });

  it('stems only when enough of the word is left', () => {
    const words = ['failed', 'failing', 'fails', 'nightly', 'crashes', 'drives', 'games', 'speed', 'string', 'status', 'process', 'redis', 'disk'];
    expect(words.map(stemWord)).toEqual(['fail', 'fail', 'fail', 'night', 'crash', 'driv', 'game', 'speed', 'string', 'status', 'process', 'redis', 'disk']);
  });

  it('strips a request type’s name from the front of a submitted title only', () => {
    expect(stripTypePrefix('Plex – Interstellar – stutters', ['General', 'Plex'])).toBe('Interstellar – stutters');
    expect(stripTypePrefix('Plex transcoder crash', ['Plex'])).toBe('Plex transcoder crash');
    expect(stripTypePrefix('game servers - Valheim lag', ['Game servers'])).toBe('Valheim lag');
  });

  it('strips the submit page’s scaffolding but keeps the answers', () => {
    const md = [
      'It stops every few minutes.',
      '### Plex details\n\n- **Device or app:** Roku\n- **When did it start?** Yesterday',
      '**Anything else?**\n\nOnly in the evening',
      '---\n_Submitted by Sam through the submit page (Plex)._',
    ].join('\n\n');
    const out = stripSubmitScaffolding(md);
    expect(out).toContain('Roku');
    expect(out).toContain('Only in the evening');
    for (const gone of ['details', 'Device or app', 'When did it start', 'Anything else', 'Submitted']) expect(out).not.toContain(gone);
  });
});

describe('similar tickets', () => {
  it('finds finished tickets that share words, with how they were resolved', () => {
    const old = fixed('Plex buffering on the living room TV', 'Moved the **TV** to the [5 GHz](https://x) network');
    createCard(t.ctx, { title: 'Plex buffering in the bedroom' }); // still open
    fixed('NAS fan is loud');

    const found = similarCards(t.ctx, { title: 'Plex keeps buffering', description: '' });
    expect(found).toEqual([
      {
        id: old.id,
        ticketNo: old.ticketNo,
        title: 'Plex buffering on the living room TV',
        completedAt: expect.any(String),
        archived: false,
        resolution: 'Fixed',
        note: 'Moved the TV to the 5 GHz network',
        parent: null,
      },
    ]);
  });

  it('needs two shared words, so one common topic isn’t enough', () => {
    fixed('Plex transcoder crash');
    expect(similar('Plex library scan is slow')).toEqual([]);
    expect(similar('Plex transcoder stutters')).toEqual(['Plex transcoder crash']);
    // With only one distinctive word, one match will do.
    expect(similar('Transcoder')).toEqual(['Plex transcoder crash']);
  });

  it('needs one of the shared words to come from the title', () => {
    fixed('Web UI unreachable after changing the bonding mode', 'Set the next network change back');
    // Only description words in common ("network", "change"): not the same problem.
    expect(similar('Label the patch panel', 'So the next network change doesn’t start with unplugging cables')).toEqual([]);
    expect(similar('Web UI down after network change')).toEqual(['Web UI unreachable after changing the bonding mode']);
  });

  it('doesn’t count two forms of one word as two matches', () => {
    fixed('Pi-hole stops resolving after the router update');
    expect(similar('Weekly plugin update check', 'Check for container and plugin updates')).toEqual([]);
  });

  it('matches technical words split by punctuation, and word beginnings', () => {
    fixed('nginx.conf typo broke the 502 page');
    expect(similar('502 from nginx after editing conf')).toEqual(['nginx.conf typo broke the 502 page']);
    fixed('Backups failing every night');
    expect(similar('Nightly backup failed')).toEqual(['Backups failing every night']);
  });

  it('includes archived tickets; leaves out trashed, work cards, itself and ones already linked', () => {
    const archived = fixed('Pi-hole DNS outage');
    archiveCard(t.ctx, archived.id);
    const trashed = fixed('Pi-hole DNS slow');
    deleteCard(t.ctx, trashed.id);
    const work = createCard(t.ctx, { title: 'Pi-hole DNS rebuild', kind: 'work' });
    completeCard(t.ctx, work.id, { includeChildren: false });
    const linked = fixed('Pi-hole DNS blocked a site');
    const current = createCard(t.ctx, { title: 'Pi-hole DNS down again' });
    createLink(t.ctx, current.id, linked.id, 'relates');

    const found = similarCards(t.ctx, { title: current.title, description: '', excludeId: current.id });
    expect(found.map((f) => [f.title, f.archived])).toEqual([['Pi-hole DNS outage', true]]);
  });

  it('isn’t fooled by the submit page’s scaffolding', () => {
    const scaffold = (answer: string) =>
      `It broke.\n\n### General details\n\n- **Where does this apply?** ${answer}\n\n---\n_Submitted through the submit page (General)._`;
    fixed('General – Minecraft lag', '', scaffold('Game server'));
    expect(similar('General – Printer jammed', scaffold('Something else'))).toEqual([]);
    expect(similar('General – Minecraft crashes', scaffold('Game server'))).toEqual(['General – Minecraft lag']);
  });

  it('ignores words on most cards once there are enough of them', () => {
    for (let i = 0; i < 24; i++) createCard(t.ctx, { title: `Plex request ${i}` });
    fixed('Plex transcoder crash');
    // "plex" is on almost every card, so it no longer counts towards the two shared words.
    expect(similar('Plex transcoder stutters')).toEqual([]);
    expect(similar('Plex transcoder crash loop')).toEqual(['Plex transcoder crash']);
  });

  it('points at the work card when the ticket was finished with it', () => {
    const work = createCard(t.ctx, { title: 'Replace the UPS', kind: 'work' });
    createCard(t.ctx, { title: 'UPS battery beeping', parentId: work.id });
    completeCard(t.ctx, work.id, { includeChildren: true });
    const [hit] = similarCards(t.ctx, { title: 'UPS battery alarm', description: '' });
    expect(hit).toMatchObject({ title: 'UPS battery beeping', note: '', parent: { id: work.id, title: 'Replace the UPS' } });
  });

  it('returns at most five, best first', () => {
    for (let i = 0; i < 8; i++) fixed(`Docker container ${i} restarting`);
    fixed('Docker container restarting loop');
    const found = similar('Docker container restarting loop');
    expect(found).toHaveLength(5);
    expect(found[0]).toBe('Docker container restarting loop');
  });
});

describe('similar tickets over HTTP', () => {
  let app: TestApp;
  afterEach(() => app?.shutdown());

  it('needs a session, answers for a card or for text, and nothing for work cards', async () => {
    app = await makeApp();
    const cookie = await setupAndLogin(app);
    const old = createCard(app.ctx, { title: 'Router reboots at night' });
    completeCard(app.ctx, old.id, { includeChildren: false, resolution: { reason: 'Fixed', note: 'Firmware update' } });
    const current = createCard(app.ctx, { title: 'Router reboots randomly' });
    const work = createCard(app.ctx, { title: 'Router reboots project', kind: 'work' });

    expect((await client(app.app)('GET', `/api/cards/${current.id}/similar`)).statusCode).toBe(401);
    const api = client(app.app, cookie);
    const forCard = await api('GET', `/api/cards/${current.id}/similar`);
    expect(forCard.statusCode).toBe(200);
    expect(forCard.json().map((s: { id: number }) => s.id)).toEqual([old.id]);
    expect((await api('GET', `/api/cards/${work.id}/similar`)).json()).toEqual([]);
    expect((await api('GET', '/api/cards/9999/similar')).statusCode).toBe(404);

    const forText = await api('GET', `/api/similar?title=${encodeURIComponent('Router keeps rebooting')}&description=${encodeURIComponent('at night')}`);
    expect(forText.json().map((s: { id: number }) => s.id)).toEqual([old.id]);
    expect((await api('GET', `/api/similar?title=${'x'.repeat(400)}`)).statusCode).toBe(400);
  });
});

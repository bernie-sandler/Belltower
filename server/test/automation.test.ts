import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listActivity } from '../src/services/activity';
import { createCard, getCard, updateCard } from '../src/services/cards';
import type { AppEvent } from '../src/services/context';
import { createLink } from '../src/services/links';
import { DIGEST_RETRY_MS, Notifier } from '../src/services/notify';
import { lastDelivery, updateDiscordSettings, updateGeneralSettings } from '../src/services/settings';
import { createToken, listTokens } from '../src/services/tokens';
import { addPerson, client, columnId, makeApp, makeCtx, setupAndLogin, type TestApp } from './helpers';

describe('API tokens and /api/v1', () => {
  let app: TestApp;
  afterEach(() => app?.shutdown());

  async function setup(canComplete = false) {
    app = await makeApp();
    const c = client(app.app, await setupAndLogin(app));
    const created = (await c('POST', '/api/tokens', { name: 'Uptime Kuma', canComplete })).json();
    return { c, token: created.token as string, info: created.info };
  }

  const v1 = (token: string | null, url: string, body: unknown) =>
    app.app.inject({
      method: 'POST',
      url,
      payload: body as object,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  it('shows a token once and stores only its hash', async () => {
    const { c, token, info } = await setup();
    expect(token).toMatch(/^tt_[\w-]{32}$/);
    expect(info).toMatchObject({ name: 'Uptime Kuma', prefix: token.slice(0, 7), revokedAt: null });
    const list = (await c('GET', '/api/tokens')).json();
    expect(JSON.stringify(list)).not.toContain(token);
    const stored = app.ctx.db.prepare('SELECT token_hash FROM api_tokens').pluck().get() as string;
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a token that rings the bell: its new tickets reach the admin’s bell (Teams off); other tokens’ don’t', async () => {
    const { c, token: quiet, info: quietInfo } = await setup();
    expect(quietInfo.ringsBell).toBe(false);
    // With Teams off the bell shows for admins while the submit page is on or such a token exists.
    const bellTokens = async () => (await c('GET', '/api/config')).json().bellTokens;
    expect(await bellTokens()).toBe(false);
    const bot = (await c('POST', '/api/tokens', { name: 'Bernard', ringsBell: true })).json();
    expect(bot.info).toMatchObject({ scope: 'full', ringsBell: true });
    expect(await bellTokens()).toBe(true);
    // Read-only tokens never ring it.
    expect((await c('POST', '/api/tokens', { name: 'Homepage', scope: 'read', ringsBell: true })).json().info.ringsBell).toBe(false);
    expect((await c('GET', '/api/tokens')).json().map((t: { name: string; ringsBell: boolean }) => [t.name, t.ringsBell])).toEqual([
      ['Homepage', false],
      ['Bernard', true],
      ['Uptime Kuma', false],
    ]);

    const bell = async () => (await c('GET', '/api/notifications')).json().items.map((n: { type: string; text: string }) => `${n.type}: ${n.text}`);
    await v1(quiet, '/api/v1/cards', { title: 'NAS offline' });
    expect(await bell()).toEqual([]);
    expect((await v1(bot.token, '/api/v1/cards', { title: 'Plex keeps buffering', dedupeKey: 'discord:1' })).statusCode).toBe(201);
    expect(await bell()).toEqual(['submitted: New ticket from API token “Bernard”']);
    // A repeat with the same key only adds a note: no second ring.
    expect((await v1(bot.token, '/api/v1/cards', { title: 'Plex keeps buffering', dedupeKey: 'discord:1' })).json().status).toBe('updated');
    expect(await bell()).toHaveLength(1);
    // A work card from the bot doesn't ring (the submit page never makes them).
    expect((await v1(bot.token, '/api/v1/cards', { title: 'Plex migration', type: 'work' })).statusCode).toBe(201);
    expect(await bell()).toHaveLength(1);
    expect((await c('DELETE', `/api/tokens/${bot.info.id}`)).statusCode).toBeLessThan(300);
    expect(await bellTokens()).toBe(false);
  });

  it('only admins make tokens that ring the bell; a deactivated owner’s token no longer shows the bell', async () => {
    app = await makeApp();
    const admin = await setupAndLogin(app);
    const c = client(app.app, admin);
    const sam = await addPerson(app, admin, 'sam');
    const asSam = client(app.app, sam.cookie);
    expect((await asSam('POST', '/api/tokens', { name: 'Sam bot', ringsBell: true })).json().info.ringsBell).toBe(false);
    expect((await c('GET', '/api/config')).json().bellTokens).toBe(false);

    const alex = await addPerson(app, admin, 'alex', 'admin');
    expect((await client(app.app, alex.cookie)('POST', '/api/tokens', { name: 'Alex bot', ringsBell: true })).json().info.ringsBell).toBe(true);
    expect((await c('GET', '/api/config')).json().bellTokens).toBe(true);
    app.ctx.db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run('2026-10-10T15:00:00.000Z', alex.id);
    expect((await c('GET', '/api/config')).json().bellTokens).toBe(false);
  });

  it('needs a valid, unrevoked bearer token, and nothing else (no cookie, no CSRF header)', async () => {
    const { c, token, info } = await setup();
    expect((await v1(null, '/api/v1/cards', { title: 'x' })).statusCode).toBe(401);
    expect((await v1('tt_wrongwrongwrongwrongwrongwrongwrong', '/api/v1/cards', { title: 'x' })).statusCode).toBe(401);
    // A browser session alone isn't enough.
    expect((await c('POST', '/api/v1/cards', { title: 'x' })).statusCode).toBe(401);

    const ok = await v1(token, '/api/v1/cards', { title: 'Disk 3 SMART warning', priority: 'P1', labels: ['Hardware'] });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ status: 'created', card: { title: 'Disk 3 SMART warning' } });
    const card = getCard(app.ctx, ok.json().card.id);
    expect(card.priority).toBe('high');
    expect(listActivity(app.ctx, card.id).find((e) => e.type === 'created')!.data).toMatchObject({ via: 'API token “Uptime Kuma”' });

    await c('DELETE', `/api/tokens/${info.id}`);
    expect((await v1(token, '/api/v1/cards', { title: 'again' })).statusCode).toBe(401);
  });

  it('updates the open ticket for a repeated dedupeKey, then notes the recovery', async () => {
    const { token } = await setup();
    const first = (await v1(token, '/api/v1/cards', { title: 'NAS offline', dedupeKey: 'nas', description: 'ping failed' })).json();
    const again = await v1(token, '/api/v1/cards', { title: 'NAS offline', dedupeKey: 'nas', description: 'still failing' });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ status: 'updated', card: { id: first.card.id } });
    const recovered = (await v1(token, '/api/v1/cards', { dedupeKey: 'nas', event: 'resolved' })).json();
    expect(recovered).toMatchObject({ status: 'recovered', card: { id: first.card.id, completedAt: null } });
    const log = listActivity(app.ctx, first.card.id).filter((e) => e.kind === 'worklog').map((e) => e.bodyMd);
    expect(log.some((b) => b?.startsWith('Seen again') && b.includes('still failing'))).toBe(true);
    expect(log.some((b) => b?.startsWith('Recovered'))).toBe(true);
    expect((await v1(token, '/api/v1/cards', { dedupeKey: 'unknown', event: 'resolved' })).json()).toEqual({ status: 'ignored', card: null });
  });

  it('completes the ticket on recovery when the token is allowed to', async () => {
    const { token } = await setup(true);
    const first = (await v1(token, '/api/v1/cards', { title: 'Router down', dedupeKey: 'router' })).json();
    const done = (await v1(token, '/api/v1/cards', { dedupeKey: 'router', event: 'resolved' })).json();
    expect(done).toMatchObject({ status: 'resolved', card: { columnId: columnId(app.ctx, 'Done') } });
    // A new problem afterwards opens a new ticket.
    const next = (await v1(token, '/api/v1/cards', { title: 'Router down', dedupeKey: 'router' })).json();
    expect(next.status).toBe('created');
    expect(next.card.id).not.toBe(first.card.id);
  });

  it('reports invalid cards', async () => {
    const { token } = await setup();
    const bad = await v1(token, '/api/v1/cards', { title: '', priority: 'P9' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().errors.join(' ')).toMatch(/title/);
    expect((await v1(token, '/api/v1/cards', { title: 'x', event: 'resolved' })).statusCode).toBe(400);
    expect((await v1(token, '/api/v1/cards', [{ title: 'x' }])).statusCode).toBe(400);
  });

  it('Uptime Kuma: test, down (once per monitor), up', async () => {
    const { token } = await setup(true);
    const kuma = (status: number | null, msg = '') =>
      v1(token, '/api/v1/hooks/uptime-kuma?labels=Network&priority=P0', {
        heartbeat: status === null ? null : { status, msg, time: '2026-10-10 10:00:00' },
        monitor: status === null ? null : { id: 7, name: 'Plex', url: 'http://tower:32400' },
        msg: status === null ? 'Uptime Kuma Testing' : `[Plex] ${msg}`,
      });
    expect((await kuma(null)).json()).toMatchObject({ status: 'ignored', test: true });
    const down = await kuma(0, 'timeout');
    expect(down.statusCode).toBe(201);
    const card = getCard(app.ctx, down.json().card.id);
    expect(card).toMatchObject({ title: 'Plex is down', priority: 'critical' });
    expect(card.description).toContain('http://tower:32400');
    expect((await kuma(0, 'still down')).json().status).toBe('updated');
    expect((await kuma(1, 'OK')).json()).toMatchObject({ status: 'resolved', card: { id: card.id } });
    expect((await kuma(2)).json().status).toBe('ignored');
  });

  it('lists tokens newest first, revoked last', () => {
    const t = makeCtx();
    try {
      createToken(t.ctx, { name: 'a', canComplete: false });
      createToken(t.ctx, { name: 'b', canComplete: false });
      expect(listTokens(t.ctx).map((x) => x.name)).toEqual(['b', 'a']);
    } finally {
      t.close();
    }
  });
});

describe('Discord notifications', () => {
  let t: ReturnType<typeof makeCtx>;
  let sent: { url: string; body: { embeds: { title: string; description?: string; url?: string; fields?: { name: string; value: string }[] }[] } }[];
  let replies: number[];
  let notifier: Notifier;
  const WEBHOOK = 'https://discord.com/api/webhooks/1/abc';

  beforeEach(() => {
    t = makeCtx();
    sent = [];
    replies = [];
    notifier = new Notifier(async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body) });
      const status = replies.shift() ?? 204;
      return { ok: status < 300, status, headers: { get: () => null }, text: async () => '' };
    }, [0, 0]);
  });
  afterEach(() => t.close());

  const configure = (events: Partial<Record<'external' | 'critical' | 'digest' | 'blocked', boolean>> = {}) =>
    updateDiscordSettings(t.ctx, {
      webhookUrl: WEBHOOK,
      events: { external: true, critical: true, digest: false, blocked: false, ...events },
      digestTime: '08:00',
    });

  it('sends nothing without a webhook', async () => {
    const card = createCard(t.ctx, { title: 'x', priority: 'critical' });
    await notifier.handle(t.ctx, { type: 'card_created', cardId: card.id, external: true });
    expect(sent).toEqual([]);
  });

  it('announces external and critical cards (with a link when the app URL is set)', async () => {
    configure();
    updateGeneralSettings(t.ctx, { ticketFormat: '{YY}{MM}{DD}-{N}', appUrl: 'https://tower.example', claudeModel: '' });
    const ext = createCard(t.ctx, { title: 'From the submit page' });
    await notifier.handle(t.ctx, { type: 'card_created', cardId: ext.id, external: true, via: 'submit page (Sam)' });
    expect(sent[0]!.url).toBe(WEBHOOK);
    expect(sent[0]!.body.embeds[0]).toMatchObject({
      title: `${ext.ticketNo} — From the submit page`,
      url: `https://tower.example/cards/${ext.id}`,
      description: 'New ticket from submit page (Sam)',
    });

    const plain = createCard(t.ctx, { title: 'Mine, normal' });
    await notifier.handle(t.ctx, { type: 'card_created', cardId: plain.id, external: false });
    expect(sent).toHaveLength(1);
    const crit = createCard(t.ctx, { title: 'Array offline', severity: 'blocker' });
    await notifier.handle(t.ctx, { type: 'card_created', cardId: crit.id, external: false });
    expect(sent[1]!.body.embeds[0]!.description).toBe('New urgent card (S1 Blocker)');
    expect(lastDelivery(t.ctx)).toMatchObject({ ok: true });
  });

  it('respects the event switches, and skips cards that no longer exist', async () => {
    configure({ external: false, critical: false });
    const c = createCard(t.ctx, { title: 'x', priority: 'critical' });
    await notifier.handle(t.ctx, { type: 'card_created', cardId: c.id, external: true });
    await notifier.handle(t.ctx, { type: 'card_created', cardId: 99999, external: true });
    expect(sent).toEqual([]);
  });

  it('reports blocked cards when turned on (events come from linking)', async () => {
    configure({ blocked: true });
    const events: AppEvent[] = [];
    t.ctx.emit = (e) => events.push(e);
    const blocker = createCard(t.ctx, { title: 'Order cable' });
    const card = createCard(t.ctx, { title: 'Rewire rack' });
    createLink(t.ctx, card.id, blocker.id, 'blocked_by');
    const blocked = events.find((e) => e.type === 'card_blocked')!;
    expect(blocked).toEqual({ type: 'card_blocked', cardId: card.id, blockerIds: [blocker.id] });
    expect(events.filter((e) => e.type === 'card_created')).toHaveLength(2);
    await notifier.handle(t.ctx, blocked);
    expect(sent[0]!.body.embeds[0]!.description).toContain('Order cable');
  });

  it('retries server errors, gives up on client errors, and records the result', async () => {
    configure();
    replies = [500, 204];
    expect(await notifier.sendTest(t.ctx)).toEqual({ ok: true, message: 'Delivered' });
    expect(sent).toHaveLength(2);
    replies = [404];
    expect(await notifier.sendTest(t.ctx)).toEqual({ ok: false, message: 'Discord answered 404' });
    expect(sent).toHaveLength(3);
    expect(lastDelivery(t.ctx)).toMatchObject({ ok: false, message: 'Discord answered 404' });
  });

  it('counts P0–P1 or S1 as urgent by default, and the levels can be changed', async () => {
    configure();
    const p1 = createCard(t.ctx, { title: 'P1 card', priority: 'high' });
    await notifier.handle(t.ctx, { type: 'card_created', cardId: p1.id, external: false });
    const p2 = createCard(t.ctx, { title: 'P2 card', priority: 'medium', severity: 'major' });
    await notifier.handle(t.ctx, { type: 'card_created', cardId: p2.id, external: false });
    expect(sent.map((x) => x.body.embeds[0]!.description)).toEqual(['New urgent card (P1 High)']);

    updateDiscordSettings(t.ctx, {
      webhookUrl: null,
      events: { external: true, critical: true, digest: false, blocked: false },
      digestTime: '08:00',
      alertPriority: 'critical',
      alertSeverity: 'major',
    });
    await notifier.handle(t.ctx, { type: 'card_created', cardId: p1.id, external: false }); // P1 no longer urgent
    await notifier.handle(t.ctx, { type: 'card_created', cardId: p2.id, external: false }); // S2 now is
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body.embeds[0]!.description).toBe('New urgent card (P2 Medium · S2 Major)');
  });

  it('alerts when a card is raised to urgent, once (changes come from editing the card)', async () => {
    configure();
    const events: AppEvent[] = [];
    t.ctx.emit = (e) => events.push(e);
    const card = createCard(t.ctx, { title: 'Fans loud', priority: 'low' });
    updateCard(t.ctx, card.id, { priority: 'medium' });
    updateCard(t.ctx, card.id, { priority: 'critical' });
    updateCard(t.ctx, card.id, { severity: 'blocker' }); // already urgent: no second alert
    updateCard(t.ctx, card.id, { title: 'Fans very loud' }); // not a level change: no event
    const raised = events.filter((e) => e.type === 'card_raised');
    expect(raised).toHaveLength(3);
    for (const e of raised) await notifier.handle(t.ctx, e);
    expect(sent.map((x) => x.body.embeds[0]!.description)).toEqual(['Raised to P0 Critical']);
  });

  it('sends the daily summary once, after the chosen time', async () => {
    configure({ digest: true });
    createCard(t.ctx, { title: 'Overdue one', dueDate: '2026-10-08' });
    createCard(t.ctx, { title: 'Due today', dueDate: '2026-10-10' });
    createCard(t.ctx, { title: 'Later', dueDate: '2026-10-20' });
    // 07:30 in Chicago: too early. 10:00: sends. Again the same day: no.
    expect(await notifier.dailyDigest(t.ctx, new Date('2026-10-10T12:30:00.000Z'))).toBe(false);
    expect(await notifier.dailyDigest(t.ctx, new Date('2026-10-10T15:00:00.000Z'))).toBe(true);
    expect(await notifier.dailyDigest(t.ctx, new Date('2026-10-10T18:00:00.000Z'))).toBe(false);
    const fields = sent[0]!.body.embeds[0]!.fields!;
    expect(fields.map((f) => f.name)).toEqual(['Overdue (1)', 'Due today (1)']);
    expect(fields[0]!.value).toContain('Overdue one');
    expect(JSON.stringify(sent)).not.toContain('Later');
  });

  it('sends an all-clear summary when nothing is due, and tries again a while after sending failed', async () => {
    configure({ digest: true });
    replies = [500, 500, 500];
    const at = (ms: number) => new Date(Date.parse('2026-10-10T15:00:00.000Z') + ms);
    expect(await notifier.dailyDigest(t.ctx, at(0))).toBe(false);
    expect(sent).toHaveLength(3);
    // A dead endpoint isn't hammered every minute.
    expect(await notifier.dailyDigest(t.ctx, at(60_000))).toBe(false);
    expect(sent).toHaveLength(3);
    expect(await notifier.dailyDigest(t.ctx, at(DIGEST_RETRY_MS))).toBe(true);
    expect(sent.at(-1)!.body.embeds[0]!.description).toBe('Nothing overdue or due today.');
    expect(await notifier.dailyDigest(t.ctx, at(DIGEST_RETRY_MS + 60_000))).toBe(false);
  });

  it('the Settings test button goes through the app', async () => {
    const app = await makeApp();
    try {
      const c = client(app.app, await setupAndLogin(app));
      const res = await c('POST', '/api/settings/discord/test');
      // makeApp has no notifier: the route says so instead of failing oddly.
      expect(res.statusCode).toBe(503);
    } finally {
      await app.shutdown();
    }
  });
});

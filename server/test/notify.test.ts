import { createHmac } from 'node:crypto';
import type { NotifyChannelBody } from '@tt/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCard } from '../src/services/cards';
import { Notifier, WEBHOOK_EVENTS } from '../src/services/notify';
import {
  getAlertSettings,
  getChannelSettings,
  lastDelivery,
  settingsResponse,
  updateAlertSettings,
  updateChannelSettings,
  updateDiscordSettings,
  updateGeneralSettings,
} from '../src/services/settings';
import { client, makeApp, makeCtx, setupAndLogin } from './helpers';

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
  json: Record<string, unknown>;
}

let t: ReturnType<typeof makeCtx>;
let sent: Sent[];
/** Status per request, or an Error to throw (a network failure). */
let replies: (number | Error)[];
let notifier: Notifier;

const EVENTS = { external: true, critical: true, digest: false, blocked: false };
const channel = (over: Partial<NotifyChannelBody> = {}): NotifyChannelBody => ({ url: null, secret: null, events: EVENTS, ...over });

beforeEach(() => {
  t = makeCtx();
  sent = [];
  replies = [];
  notifier = new Notifier(async (url, init) => {
    sent.push({ url, headers: init.headers, body: init.body, json: JSON.parse(init.body) as Record<string, unknown> });
    expect(init.redirect).toBe('error');
    const reply = replies.shift() ?? 200;
    if (reply instanceof Error) throw reply;
    return { ok: reply < 300, status: reply, headers: { get: () => null }, text: async () => 'secret page body' };
  }, [0, 0]);
  updateGeneralSettings(t.ctx, { ticketFormat: '{YY}{MM}{DD}-{N}', appUrl: 'https://tower.example', claudeModel: '' });
});
afterEach(() => t.close());

describe('channel settings', () => {
  it('keeps saved secrets out of the settings sent to the browser, showing only hints', () => {
    updateChannelSettings(t.ctx, 'ntfy', channel({ url: 'https://ntfy.sh/belltower-x7Kq2', secret: 'tk_supersecret' }));
    updateChannelSettings(t.ctx, 'gotify', channel({ url: 'https://gotify.lan/', secret: 'AppTokenSecret' }));
    updateChannelSettings(t.ctx, 'webhook', channel({ url: 'https://hooks.example/in/abc123?key=zzz', secret: 'whsec' }));
    const s = settingsResponse(t.ctx, { modelFromEnv: null, enabled: false });
    const text = JSON.stringify(s);
    for (const secret of ['tk_supersecret', 'AppTokenSecret', 'whsec', 'belltower-x7Kq2', 'abc123', 'key=zzz']) expect(text).not.toContain(secret);
    expect(s.notify.channels).toMatchObject({
      ntfy: { set: true, hint: 'https://ntfy.sh/…', secretSet: true },
      gotify: { set: true, hint: 'https://gotify.lan', secretSet: true },
      webhook: { set: true, hint: 'https://hooks.example/…', secretSet: true },
    });
  });

  it('keeps or removes the address and secret, and Gotify needs its token', () => {
    updateChannelSettings(t.ctx, 'gotify', channel({ url: 'https://gotify.lan' }));
    expect(settingsResponse(t.ctx, { modelFromEnv: null, enabled: false }).notify.channels.gotify.set).toBe(false);
    updateChannelSettings(t.ctx, 'gotify', channel({ secret: 'Atoken' }));
    expect(getChannelSettings(t.ctx, 'gotify')).toMatchObject({ url: 'https://gotify.lan/', secret: 'Atoken' });
    updateChannelSettings(t.ctx, 'gotify', channel({ secret: '' }));
    expect(getChannelSettings(t.ctx, 'gotify').secret).toBeNull();
    updateChannelSettings(t.ctx, 'gotify', channel({ url: '' }));
    expect(getChannelSettings(t.ctx, 'gotify').url).toBeNull();
  });

  it('forgets the secret when the address moves to another host, unless a new one comes with it', () => {
    updateChannelSettings(t.ctx, 'ntfy', channel({ url: 'https://ntfy.sh/topic-one', secret: 'tk_a' }));
    updateChannelSettings(t.ctx, 'ntfy', channel({ url: 'https://ntfy.sh/topic-two' }));
    expect(getChannelSettings(t.ctx, 'ntfy').secret).toBe('tk_a'); // same host
    updateChannelSettings(t.ctx, 'ntfy', channel({ url: 'https://attacker.example/topic' }));
    expect(getChannelSettings(t.ctx, 'ntfy').secret).toBeNull();
    updateChannelSettings(t.ctx, 'ntfy', channel({ url: 'https://ntfy.lan/topic', secret: 'tk_b' }));
    expect(getChannelSettings(t.ctx, 'ntfy').secret).toBe('tk_b');
  });

  it('checks addresses: http(s) only, no user names, and an ntfy topic', () => {
    expect(() => updateChannelSettings(t.ctx, 'webhook', channel({ url: 'ftp://x.example/' }))).toThrow(/http/);
    expect(() => updateChannelSettings(t.ctx, 'webhook', channel({ url: 'https://user:pw@x.example/' }))).toThrow(/user name/);
    expect(() => updateChannelSettings(t.ctx, 'ntfy', channel({ url: 'https://ntfy.sh/' }))).toThrow(/topic/);
    expect(() => updateChannelSettings(t.ctx, 'ntfy', channel({ url: 'https://ntfy.sh/bad topic!' }))).toThrow(/topic/);
    updateChannelSettings(t.ctx, 'webhook', channel({ url: 'http://192.168.1.20:8123/api/webhook/belltower' })); // LAN is fine
  });

  it('shares the alert levels and summary time, and Discord saves no longer reset them', () => {
    updateAlertSettings(t.ctx, { digestTime: '07:15', alertPriority: 'critical', alertSeverity: 'major' });
    updateDiscordSettings(t.ctx, { webhookUrl: 'https://discord.com/api/webhooks/1/abc', events: EVENTS });
    expect(getAlertSettings(t.ctx)).toEqual({ digestTime: '07:15', alertPriority: 'critical', alertSeverity: 'major' });
  });
});

describe('sending', () => {
  it('ntfy: JSON publish to the server root, with the topic, priority, link and token', async () => {
    updateChannelSettings(t.ctx, 'ntfy', channel({ url: 'https://push.example/ntfy/belltower', secret: 'tk_abc' }));
    const card = createCard(t.ctx, { title: 'Array offline', severity: 'blocker' });
    await notifier.handle(t.ctx, { type: 'card_created', cardId: card.id, external: false });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://push.example/ntfy/');
    expect(sent[0]!.headers.Authorization).toBe('Bearer tk_abc');
    expect(sent[0]!.json).toEqual({
      topic: 'belltower',
      title: `${card.ticketNo} — Array offline`,
      message: 'New urgent card (S1 Blocker)\n\nColumn: Triage · S1 Blocker',
      priority: 5,
      markdown: true,
      click: `https://tower.example/cards/${card.id}`,
    });
  });

  it('Gotify: POST /message with the app token and Markdown', async () => {
    updateChannelSettings(t.ctx, 'gotify', channel({ url: 'https://gotify.lan/sub', secret: 'Atoken' }));
    const card = createCard(t.ctx, { title: 'From the page' });
    await notifier.handle(t.ctx, { type: 'card_created', cardId: card.id, external: true, via: 'submit page (Sam)' });
    expect(sent[0]!.url).toBe('https://gotify.lan/sub/message');
    expect(sent[0]!.headers['X-Gotify-Key']).toBe('Atoken');
    expect(sent[0]!.json).toMatchObject({
      title: `${card.ticketNo} — From the page`,
      message: 'New ticket from submit page (Sam)\n\nColumn: Triage',
      priority: 5,
      extras: { 'client::display': { contentType: 'text/markdown' }, 'client::notification': { click: { url: `https://tower.example/cards/${card.id}` } } },
    });
  });

  it('webhook: the documented payload, signed when there is a secret', async () => {
    updateChannelSettings(t.ctx, 'webhook', channel({ url: 'https://hooks.example/in', secret: 'whsec' }));
    const card = createCard(t.ctx, { title: 'Disk 3 SMART errors', priority: 'high', description: 'private notes' });
    await notifier.handle(t.ctx, { type: 'card_created', cardId: card.id, external: false });
    const s = sent[0]!;
    // The 1.x contract: these keys, these meanings. Never the description.
    expect(s.json).toEqual({
      version: 1,
      event: 'new_urgent',
      title: `${card.ticketNo} — Disk 3 SMART errors`,
      message: 'New urgent card (P1 High)',
      urgent: true,
      url: `https://tower.example/cards/${card.id}`,
      card: {
        id: card.id,
        ticketNo: card.ticketNo,
        title: 'Disk 3 SMART errors',
        kind: 'ticket',
        column: 'Triage',
        priority: 'P1',
        severity: null,
        dueDate: null,
        url: `https://tower.example/cards/${card.id}`,
      },
      sentAt: '2026-10-10T15:00:00.000Z',
    });
    expect(s.body).not.toContain('private notes');
    expect(s.headers['X-Belltower-Event']).toBe('new_urgent');
    expect(s.headers['X-Belltower-Delivery']).toMatch(/^[0-9a-f-]{36}$/);
    const ts = s.headers['X-Belltower-Timestamp']!;
    expect(s.headers['X-Belltower-Signature']).toBe(`sha256=${createHmac('sha256', 'whsec').update(`${ts}.${s.body}`).digest('hex')}`);
    expect(WEBHOOK_EVENTS).toEqual(['new_external', 'new_urgent', 'raised', 'blocked', 'digest', 'test']);
  });

  it('keeps one delivery id across retries', async () => {
    updateChannelSettings(t.ctx, 'webhook', channel({ url: 'https://hooks.example/in' }));
    replies = [503, 200];
    expect(await notifier.sendTest(t.ctx, 'webhook')).toEqual({ ok: true, message: 'Delivered' });
    expect(sent).toHaveLength(2);
    expect(sent[0]!.headers['X-Belltower-Delivery']).toBe(sent[1]!.headers['X-Belltower-Delivery']);
    expect(sent[0]!.headers['X-Belltower-Signature']).toBeUndefined();
  });

  it('each channel gets only the events it picked', async () => {
    updateDiscordSettings(t.ctx, { webhookUrl: 'https://discord.com/api/webhooks/1/abc', events: { ...EVENTS, critical: false } });
    updateChannelSettings(t.ctx, 'ntfy', channel({ url: 'https://ntfy.sh/urgent-only', events: { external: false, critical: true, digest: false, blocked: false } }));
    const card = createCard(t.ctx, { title: 'Urgent from outside', priority: 'critical' });
    await notifier.handle(t.ctx, { type: 'card_created', cardId: card.id, external: true, via: 'API token “Kuma”' });
    // Discord announces it as a new outside ticket; ntfy (urgent only) as an urgent card.
    const discord = sent.find((s) => s.url.includes('discord'))!;
    const ntfy = sent.find((s) => s.url.includes('ntfy'))!;
    expect((discord.json.embeds as { description: string }[])[0]!.description).toBe('New ticket from API token “Kuma”');
    expect(ntfy.json.message).toMatch(/^New urgent card \(P0 Critical\)/);

    sent = [];
    const plain = createCard(t.ctx, { title: 'Outside, not urgent' });
    await notifier.handle(t.ctx, { type: 'card_created', cardId: plain.id, external: true });
    expect(sent.map((s) => new URL(s.url).host)).toEqual(['discord.com']);
  });

  it('reports only the status code or the kind of network failure, never what came back', async () => {
    updateChannelSettings(t.ctx, 'webhook', channel({ url: 'http://10.0.0.5/admin' }));
    replies = [403];
    expect(await notifier.sendTest(t.ctx, 'webhook')).toEqual({ ok: false, message: 'The webhook answered 403' });
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    replies = [refused, refused, refused];
    expect((await notifier.sendTest(t.ctx, 'webhook')).message).toBe('Couldn’t reach the webhook: ECONNREFUSED');
    const redirected = Object.assign(new TypeError('fetch failed'), { cause: { message: 'unexpected redirect' } });
    replies = [redirected, redirected, redirected];
    const before = sent.length;
    expect((await notifier.sendTest(t.ctx, 'webhook')).message).toMatch(/redirects aren’t followed/);
    expect(sent.length - before).toBe(1); // not retried
    expect(JSON.stringify(lastDelivery(t.ctx, 'webhook'))).not.toContain('secret page body');
    expect(JSON.stringify(lastDelivery(t.ctx, 'webhook'))).not.toContain('10.0.0.5');
  });

  it('says what a channel is missing before trying', async () => {
    expect(await notifier.sendTest(t.ctx, 'ntfy')).toEqual({ ok: false, message: 'ntfy isn’t set up' });
    updateChannelSettings(t.ctx, 'gotify', channel({ url: 'https://gotify.lan' }));
    expect(await notifier.sendTest(t.ctx, 'gotify')).toEqual({ ok: false, message: 'Gotify needs its address and an app token' });
    expect(sent).toEqual([]);
  });
});

describe('daily summary per channel', () => {
  const at = (iso: string) => new Date(iso);

  it('goes to each channel once, and one failing doesn’t resend to the others', async () => {
    updateDiscordSettings(t.ctx, { webhookUrl: 'https://discord.com/api/webhooks/1/abc', events: { ...EVENTS, digest: true } });
    updateChannelSettings(t.ctx, 'ntfy', channel({ url: 'https://ntfy.sh/today', events: { ...EVENTS, digest: true } }));
    updateChannelSettings(t.ctx, 'webhook', channel({ url: 'https://hooks.example/in', events: { ...EVENTS, digest: false } }));
    createCard(t.ctx, { title: 'Overdue one', dueDate: '2026-10-08' });
    // Discord answers; ntfy fails all three tries.
    notifier = new Notifier(async (url, init) => {
      sent.push({ url, headers: init.headers, body: init.body, json: JSON.parse(init.body) as Record<string, unknown> });
      const ok = url.includes('discord') || sent.filter((s) => s.url.includes('ntfy')).length > 3;
      return { ok, status: ok ? 200 : 502, headers: { get: () => null }, text: async () => '' };
    }, [0, 0]);

    expect(await notifier.dailyDigest(t.ctx, at('2026-10-10T15:00:00.000Z'))).toBe(true);
    expect(sent.filter((s) => s.url.includes('discord'))).toHaveLength(1);
    expect(sent.filter((s) => s.url.includes('ntfy'))).toHaveLength(3);
    expect(lastDelivery(t.ctx, 'ntfy')).toMatchObject({ ok: false, message: 'ntfy answered 502' });

    // Half an hour later only ntfy tries again; the webhook never wanted it.
    expect(await notifier.dailyDigest(t.ctx, at('2026-10-10T15:30:00.000Z'))).toBe(true);
    expect(sent.filter((s) => s.url.includes('discord'))).toHaveLength(1);
    const ntfy = sent.filter((s) => s.url.includes('ntfy')).at(-1)!;
    expect(ntfy.json).toMatchObject({ title: 'Belltower: today', message: expect.stringContaining('**Overdue (1)**') });
    expect(sent.some((s) => s.url.includes('hooks.example'))).toBe(false);
    expect(await notifier.dailyDigest(t.ctx, at('2026-10-10T16:00:00.000Z'))).toBe(false);
  });

  it('Send summary now works per channel, with the cards in the webhook payload', async () => {
    updateChannelSettings(t.ctx, 'webhook', channel({ url: 'https://hooks.example/in' }));
    const card = createCard(t.ctx, { title: 'Due today', dueDate: '2026-10-10' });
    expect(await notifier.sendDigest(t.ctx, at('2026-10-10T15:00:00.000Z'), 'webhook')).toEqual({ ok: true, message: 'Delivered' });
    expect(sent[0]!.json).toMatchObject({
      event: 'digest',
      title: 'Belltower: today',
      message: '1 due today',
      card: null,
      digest: { overdue: [], dueToday: [{ id: card.id, title: 'Due today', dueDate: '2026-10-10' }] },
    });
  });
});

describe('notification settings over HTTP', () => {
  it('saves channels and alert levels, and test buttons need the notifier', async () => {
    const app = await makeApp();
    try {
      const api = client(app.app, await setupAndLogin(app));
      const put = await api('PUT', '/api/settings/notify/ntfy', channel({ url: 'https://ntfy.sh/my-topic', secret: 'tk_1' }));
      expect(put.statusCode).toBe(200);
      expect(put.json().notify.channels.ntfy).toMatchObject({ set: true, secretSet: true, hint: 'https://ntfy.sh/…' });
      expect(put.body).not.toContain('tk_1');
      expect((await api('PUT', '/api/settings/notify/ntfy', channel({ url: 'https://ntfy.sh/' }))).statusCode).toBe(400);
      expect((await api('PUT', '/api/settings/notify/webhook', channel({ url: 'javascript:alert(1)' }))).statusCode).toBe(400);
      const alerts = await api('PUT', '/api/settings/notify', { digestTime: '06:45', alertPriority: 'medium', alertSeverity: 'minor' });
      expect(alerts.json().notify.alerts).toEqual({ digestTime: '06:45', alertPriority: 'medium', alertSeverity: 'minor' });
      // makeApp has no notifier: the routes say so instead of failing oddly.
      expect((await api('POST', '/api/settings/notify/ntfy/test')).statusCode).toBe(503);
      expect((await client(app.app)('PUT', '/api/settings/notify/gotify', channel())).statusCode).toBe(401);
    } finally {
      await app.shutdown();
    }
  });
});

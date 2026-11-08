// Notifications: Discord, ntfy, Gotify and a generic webhook (Settings → Notifications). Nothing is
// sent through a channel until it has an address. Events arrive through ctx.emit (inside the
// change's transaction), so handling is deferred and re-checks the card. Each channel picks its
// own events; what counts as urgent and when the daily summary goes out are shared.
//
// Delivery: 10 s timeout, 2 retries, honouring 429s, never following a redirect (it could carry a
// token to another host). For channels other than Discord a failure reports the status code only,
// never the response body, so Send test can't be used to read pages on the network. The last
// result per channel shows in Settings.

import {
  PRIORITIES,
  PRIORITY_CODES,
  PRIORITY_LABELS,
  SEVERITIES,
  SEVERITY_CODES,
  SEVERITY_LABELS,
  type Priority,
  type Severity,
} from '@tt/shared';
import { createHmac, randomUUID } from 'node:crypto';
import { getSetting, setSetting, stmt } from '../db/connection';
import { localDateOf } from '../lib/localdate';
import { localTimeOf } from '../lib/tz';
import type { AppEvent, Ctx } from './context';
import {
  channelReady,
  digestKey,
  getAlertSettings,
  getChannelSettings,
  getDiscordSettings,
  getGeneralSettings,
  recordDelivery,
  type AlertSettings,
  type AnyChannel,
  type ChannelEvents,
} from './settings';

/** At or above the alert levels in Settings (P0 is index 0, S1 is index 0). */
export function isUrgent(s: Pick<AlertSettings, 'alertPriority' | 'alertSeverity'>, priority: Priority | null, severity: Severity | null): boolean {
  return (
    (priority !== null && PRIORITIES.indexOf(priority) <= PRIORITIES.indexOf(s.alertPriority)) ||
    (severity !== null && SEVERITIES.indexOf(severity) <= SEVERITIES.indexOf(s.alertSeverity))
  );
}

function levels(c: { priority: Priority | null; severity: Severity | null }): string {
  return [c.priority ? PRIORITY_LABELS[c.priority] : null, c.severity ? SEVERITY_LABELS[c.severity] : null].filter(Boolean).join(' · ');
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: 'error' },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

interface Embed {
  title: string;
  url?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
}

const COLOR = { critical: 0xf87168, external: 0x579dff, blocked: 0xfea362, digest: 0x9f8fef, test: 0x4bce97 } as const;

/** How each channel is named in delivery results, mid-sentence and at the start ("ntfy answered 403"; ntfy is always lowercase). */
const NAME: Record<AnyChannel, string> = { discord: 'Discord', ntfy: 'ntfy', gotify: 'Gotify', webhook: 'the webhook' };
const START: Record<AnyChannel, string> = { ...NAME, webhook: 'The webhook' };

/** After a failed daily summary, a channel waits this long before trying again. */
export const DIGEST_RETRY_MS = 30 * 60 * 1000;
/** ntfy treats longer messages as attachments. */
const NTFY_MAX_BYTES = 4000;

export interface CardInfo {
  id: number;
  ticket_no: string | null;
  title: string;
  kind: 'ticket' | 'work';
  priority: Priority | null;
  severity: Severity | null;
  column_name: string;
  completed_at: string | null;
  deleted_at: string | null;
  due_date: string | null;
}

const CARD_COLUMNS = `c.id, c.ticket_no, c.title, c.kind, c.priority, c.severity, col.name AS column_name, c.completed_at, c.deleted_at, c.due_date`;

function cardInfo(ctx: Ctx, id: number): CardInfo | null {
  return (stmt(ctx.db, `SELECT ${CARD_COLUMNS} FROM cards c JOIN columns col ON col.id = c.column_id WHERE c.id = ?`).get(id) as CardInfo | undefined) ?? null;
}

/** Open cards on the board that are overdue or due today (the daily summary), soonest first. At most 50. */
export function dueCards(ctx: Ctx, today: string): { overdue: CardInfo[]; dueToday: CardInfo[] } {
  const rows = stmt(
    ctx.db,
    `SELECT ${CARD_COLUMNS}
       FROM cards c JOIN columns col ON col.id = c.column_id
      WHERE c.deleted_at IS NULL AND c.archived_at IS NULL AND c.completed_at IS NULL AND c.due_date IS NOT NULL AND c.due_date <= ?
      ORDER BY c.due_date, c.id LIMIT 50`,
  ).all(today) as CardInfo[];
  return { overdue: rows.filter((c) => c.due_date! < today), dueToday: rows.filter((c) => c.due_date === today) };
}

/** A channel that can send, with what it's set up to send. */
interface Target {
  channel: AnyChannel;
  url: string;
  secret: string | null;
  events: ChannelEvents;
}

/** The names a webhook receives in `event` (a fixed list; part of the webhook's contract). */
export const WEBHOOK_EVENTS = ['new_external', 'new_urgent', 'raised', 'blocked', 'digest', 'test'] as const;
type EventName = (typeof WEBHOOK_EVENTS)[number];

/** What happened, before it's dressed up for a particular channel. */
interface Message {
  event: EventName;
  /** What happened: "New ticket from submit page (Sam)". */
  heading: string;
  urgent: boolean;
  color: number;
  card: CardInfo | null;
  digest?: { overdue: CardInfo[]; dueToday: CardInfo[] };
}

interface Outgoing {
  url: string;
  headers: Record<string, string>;
  body: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cardTitle = (c: Pick<CardInfo, 'ticket_no' | 'title'>) => `${c.ticket_no ? `${c.ticket_no} — ` : ''}${c.title}`;

/** Cuts `s` to at most `max` bytes of UTF-8 without splitting a character (emoji included). */
function cutBytes(s: string, max: number): string {
  if (Buffer.byteLength(s) <= max) return s;
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > max - 3) break; // room for the "…"
    out += ch;
    bytes += size;
  }
  return `${out}…`;
}

/** The first `n` characters, counting an emoji as one. */
const firstChars = (s: string, n: number) => Array.from(s).slice(0, n).join('');

/**
 * Text from outside (a submitter's name, ticket titles) shown as Markdown in ntfy and Gotify, with
 * the characters that start Markdown syntax escaped, so a name like ![](http://…) can't load a
 * remote image or disguise a link.
 */
const escapeMd = (s: string) => s.replace(/[\\`*_[\]<>|~]/g, '\\$&'); // with [ ] escaped, ( ) and ! can't form links or images

export class Notifier {
  /** When each channel's daily summary last failed (in memory: a restart simply tries again). */
  private readonly digestFailedAt = new Map<AnyChannel, number>();

  constructor(
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly retryDelaysMs: number[] = [1000, 3000],
  ) {}

  /** Channels with an address (Discord first). */
  private targets(ctx: Ctx): Target[] {
    const discord = getDiscordSettings(ctx);
    const out: Target[] = discord.webhookUrl ? [{ channel: 'discord', url: discord.webhookUrl, secret: null, events: discord.events }] : [];
    for (const channel of ['ntfy', 'gotify', 'webhook'] as const) {
      const c = getChannelSettings(ctx, channel);
      if (channelReady(channel, c)) out.push({ channel, url: c.url!, secret: c.secret, events: c.events });
    }
    return out;
  }

  /** Reacts to an app event (call it deferred, after the change has committed). */
  async handle(ctx: Ctx, event: AppEvent): Promise<void> {
    const targets = this.targets(ctx);
    if (!targets.length) return;
    const card = cardInfo(ctx, event.cardId);
    if (!card || card.deleted_at) return; // rolled back, or already trashed
    const alerts = getAlertSettings(ctx);
    // `urgent` always says whether the card itself counts as urgent (the webhook documents it so).
    const urgent = isUrgent(alerts, card.priority, card.severity);
    const message = (name: EventName, heading: string, color: number): Message => ({ event: name, heading, color, urgent, card });

    // Which message (if any) a channel with these events gets.
    let pick: (events: ChannelEvents) => Message | null;
    if (event.type === 'card_created') {
      const external = event.external ? message('new_external', `New ticket from ${event.via ?? 'outside'}`, urgent ? COLOR.critical : COLOR.external) : null;
      const critical = urgent ? message('new_urgent', `New urgent card (${levels(card)})`, COLOR.critical) : null;
      pick = (e) => (external && e.external ? external : critical && e.critical ? critical : null);
    } else if (event.type === 'card_raised') {
      // Only when it *becomes* urgent, so editing an already-urgent card doesn't repeat the alert.
      const { from, to } = event;
      const raised =
        !card.completed_at && !isUrgent(alerts, from.priority, from.severity) && isUrgent(alerts, to.priority, to.severity)
          ? message('raised', `Raised to ${levels(to)}`, COLOR.critical)
          : null;
      pick = (e) => (raised && e.critical ? raised : null);
    } else {
      if (card.completed_at) return;
      const blockers = event.blockerIds
        .map((id) => cardInfo(ctx, id))
        .filter((b): b is CardInfo => b !== null)
        .map((b) => `${b.ticket_no ?? `#${b.id}`} ${b.title}`)
        .join(', ');
      const blocked = message('blocked', `Blocked by ${blockers || 'an open card'}`, COLOR.blocked);
      pick = (e) => (e.blocked ? blocked : null);
    }
    await Promise.all(
      targets.map(async (t) => {
        const m = pick(t.events);
        if (m) await this.deliver(ctx, t, m);
      }),
    );
  }

  /**
   * Once a day, at or after the configured local time: overdue and due-today cards, to every channel
   * with the summary turned on. Called every minute; remembers per channel the day it last went out
   * (even when there was nothing to send). A channel that failed waits DIGEST_RETRY_MS before trying
   * again. True when it went out somewhere.
   */
  async dailyDigest(ctx: Ctx, now: Date): Promise<boolean> {
    const alerts = getAlertSettings(ctx);
    if (localTimeOf(now.toISOString(), ctx.tz) < alerts.digestTime) return false;
    const today = localDateOf(now, ctx.tz);
    const waiting = (c: AnyChannel) => {
      const failed = this.digestFailedAt.get(c);
      return failed !== undefined && now.getTime() - failed < DIGEST_RETRY_MS;
    };
    const due = this.targets(ctx).filter((t) => t.events.digest && getSetting(ctx.db, digestKey(t.channel)) !== today && !waiting(t.channel));
    if (!due.length) return false;
    // Marked before sending so a slow send can't overlap the next check; un-marked if it fails.
    for (const t of due) setSetting(ctx.db, digestKey(t.channel), today);
    const message = this.digestMessage(ctx, now);
    const results = await Promise.all(due.map((t) => this.deliver(ctx, t, message)));
    due.forEach((t, i) => {
      if (results[i]!.ok) {
        this.digestFailedAt.delete(t.channel);
      } else {
        setSetting(ctx.db, digestKey(t.channel), '');
        this.digestFailedAt.set(t.channel, now.getTime());
      }
    });
    return results.some((r) => r.ok);
  }

  private digestMessage(ctx: Ctx, now: Date): Message {
    const digest = dueCards(ctx, localDateOf(now, ctx.tz));
    const empty = !digest.overdue.length && !digest.dueToday.length;
    const heading = empty
      ? 'Nothing overdue or due today.'
      : [digest.overdue.length && `${digest.overdue.length} overdue`, digest.dueToday.length && `${digest.dueToday.length} due today`].filter(Boolean).join(', ');
    return { event: 'digest', heading, urgent: false, color: empty ? COLOR.test : COLOR.digest, card: null, digest };
  }

  /** Settings → Send summary now: today's summary straight away. Sent even when nothing is due. */
  async sendDigest(ctx: Ctx, now: Date, channel: AnyChannel = 'discord'): Promise<{ ok: boolean; message: string }> {
    const target = this.targets(ctx).find((t) => t.channel === channel);
    if (!target) return { ok: false, message: notSetUp(channel) };
    return this.deliver(ctx, target, this.digestMessage(ctx, now));
  }

  /** Settings → Notifications → Send test. */
  async sendTest(ctx: Ctx, channel: AnyChannel = 'discord'): Promise<{ ok: boolean; message: string }> {
    const target = this.targets(ctx).find((t) => t.channel === channel);
    if (!target) return { ok: false, message: notSetUp(channel) };
    return this.deliver(ctx, target, { event: 'test', heading: 'Notifications are working.', urgent: false, color: COLOR.test, card: null });
  }

  private deliver(ctx: Ctx, t: Target, m: Message): Promise<{ ok: boolean; message: string }> {
    const appUrl = getGeneralSettings(ctx).appUrl;
    const link = (c: CardInfo) => (appUrl ? `${appUrl}/cards/${c.id}` : null);
    const format = { discord: toDiscord, ntfy: toNtfy, gotify: toGotify, webhook: toWebhook }[t.channel];
    let req: Outgoing;
    try {
      req = format(t, m, link, ctx.clock.now());
    } catch {
      // One channel's bad address mustn't stop the others (the daily summary sends them together).
      const message = `Couldn’t build a message for ${NAME[t.channel]}; check its address`;
      recordDelivery(ctx, t.channel, false, message);
      return Promise.resolve({ ok: false, message });
    }
    return this.send(ctx, t.channel, req);
  }

  private async send(ctx: Ctx, channel: AnyChannel, req: Outgoing): Promise<{ ok: boolean; message: string }> {
    const name = NAME[channel];
    let last = 'Not sent';
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      try {
        const res = await this.fetchImpl(req.url, {
          method: 'POST',
          headers: req.headers,
          body: req.body,
          signal: AbortSignal.timeout(10_000),
          redirect: 'error',
        });
        if (res.ok) {
          recordDelivery(ctx, channel, true, 'Delivered');
          return { ok: true, message: 'Delivered' };
        }
        last = `${START[channel]} answered ${res.status}`;
        // 4xx other than 429: the address or token is wrong; retrying won't help.
        if (res.status !== 429 && res.status < 500) break;
        const retryAfter = Number(res.headers.get('retry-after'));
        if (attempt < this.retryDelaysMs.length) {
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : this.retryDelaysMs[attempt]!);
        }
      } catch (err) {
        last = `Couldn’t reach ${name}: ${channel === 'discord' ? (err as Error).message : networkReason(err)}`;
        // A redirect or a refused port will be the same again; only network trouble is worth retrying.
        if (isRedirect(err) || isBadPort(err)) break;
        if (attempt < this.retryDelaysMs.length) await sleep(this.retryDelaysMs[attempt]!);
      }
    }
    recordDelivery(ctx, channel, false, last);
    return { ok: false, message: last };
  }
}

function notSetUp(channel: AnyChannel): string {
  if (channel === 'discord') return 'No webhook is set';
  if (channel === 'gotify') return 'Gotify needs its address and an app token';
  return `${START[channel]} isn’t set up`;
}

type FetchError = { name?: string; message?: string; cause?: { code?: string; message?: string } };

/** fetch with redirect: 'error' rejects a redirect as a network error mentioning it. */
const isRedirect = (err: unknown) => {
  const e = err as FetchError;
  return /redirect/i.test(`${e.cause?.message ?? ''} ${e.message ?? ''}`);
};

/** fetch refuses some ports outright (1, 6000, 10080…), with no error code. */
const isBadPort = (err: unknown) => /bad port/i.test((err as FetchError).cause?.message ?? '');

/** Why a request didn't get an answer, without echoing anything the other end said. */
function networkReason(err: unknown): string {
  const e = err as FetchError;
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'no answer within 10 seconds';
  if (isRedirect(err)) return 'it answered with a redirect, and redirects aren’t followed';
  if (isBadPort(err)) return 'that port is blocked for outgoing requests; use another one';
  return e.cause?.code ?? 'network error';
}

// ---------------------------------------------------------------------------------------------
// Formatting, per channel
// ---------------------------------------------------------------------------------------------

type Format = (t: Target, m: Message, link: (c: CardInfo) => string | null, now: Date) => Outgoing;

/** "Column: Triage · P1 High · S1 Blocker" (Markdown-escaped). */
function details(c: CardInfo): string {
  return escapeMd([`Column: ${c.column_name}`, levels(c)].filter(Boolean).join(' · '));
}

/** The Markdown text ntfy and Gotify show: what happened and the card's details, or the summary. */
function markdownText(m: Message, link: (c: CardInfo) => string | null): string {
  if (m.card) return `${escapeMd(m.heading)}\n\n${details(m.card)}`;
  return m.digest ? digestMarkdown(m, link) : escapeMd(m.heading);
}

/** The summary as Markdown sections ("**Overdue (2)**" and a line per card). */
function digestMarkdown(m: Message, link: (c: CardInfo) => string | null): string {
  const d = m.digest!;
  const line = (c: CardInfo) => {
    const name = escapeMd(firstChars(cardTitle(c), 120));
    const url = link(c);
    return `- ${url ? `[${name}](${url})` : name}`;
  };
  const parts = [
    d.overdue.length ? `**Overdue (${d.overdue.length})**\n${d.overdue.map(line).join('\n')}` : '',
    d.dueToday.length ? `**Due today (${d.dueToday.length})**\n${d.dueToday.map(line).join('\n')}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join('\n\n') : m.heading;
}

const titleOf = (m: Message) => (m.card ? cardTitle(m.card) : m.event === 'digest' ? 'Belltower: today' : 'Belltower test message');

/** Discord: the embeds Belltower has always sent. */
const toDiscord: Format = (t, m, link) => {
  let embed: Embed;
  if (m.card) {
    const c = m.card;
    const url = link(c);
    embed = {
      title: cardTitle(c).slice(0, 256),
      ...(url ? { url } : {}),
      description: m.heading,
      color: m.color,
      fields: [
        { name: 'Column', value: c.column_name, inline: true },
        ...(c.priority ? [{ name: 'Priority', value: PRIORITY_LABELS[c.priority], inline: true }] : []),
        ...(c.severity ? [{ name: 'Severity', value: SEVERITY_LABELS[c.severity], inline: true }] : []),
      ],
    };
  } else if (m.digest) {
    const line = (c: CardInfo) => {
      const name = `${c.ticket_no ?? `#${c.id}`} — ${c.title}`.slice(0, 120);
      const url = link(c);
      return `• ${url ? `[${name}](${url})` : name}`;
    };
    const { overdue, dueToday } = m.digest;
    const fields = [
      ...(overdue.length ? [{ name: `Overdue (${overdue.length})`, value: overdue.map(line).join('\n').slice(0, 1024) }] : []),
      ...(dueToday.length ? [{ name: `Due today (${dueToday.length})`, value: dueToday.map(line).join('\n').slice(0, 1024) }] : []),
    ];
    embed = fields.length ? { title: 'Belltower: today', color: COLOR.digest, fields } : { title: 'Belltower: today', color: COLOR.test, description: m.heading };
  } else {
    embed = { title: 'Belltower test message', description: m.heading, color: COLOR.test };
  }
  return {
    url: t.url,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'Belltower', embeds: [embed], allowed_mentions: { parse: [] } }),
  };
};

/**
 * ntfy: JSON publishing, which (unlike headers) takes any characters. It goes to the server's root
 * with the topic in the body, so the pasted topic address is split: https://host/sub/topic?auth=…
 * → POST https://host/sub/?auth=… with {"topic": "topic"} (ntfy accepts ?auth= instead of a token).
 */
const toNtfy: Format = (t, m, link) => {
  const u = new URL(t.url);
  const segments = u.pathname.split('/').filter(Boolean);
  const topic = segments.pop()!;
  const base = new URL(`${segments.length ? `/${segments.join('/')}` : ''}/${u.search}`, u.origin);
  const url = m.card ? link(m.card) : null;
  const text = markdownText(m, link);
  return {
    url: base.toString(),
    headers: { 'Content-Type': 'application/json', ...(t.secret ? { Authorization: `Bearer ${t.secret}` } : {}) },
    body: JSON.stringify({
      topic,
      title: titleOf(m).slice(0, 250),
      message: cutBytes(text, NTFY_MAX_BYTES),
      priority: m.urgent ? 5 : 3,
      markdown: true,
      ...(url ? { click: url } : {}),
    }),
  };
};

/**
 * Gotify: POST <server>/message with the app token in a header. The server may sit under a
 * sub-path; a pasted …/message endpoint and a query string are both kept as they should be.
 */
const toGotify: Format = (t, m, link) => {
  const u = new URL(t.url);
  const path = u.pathname.replace(/\/+$/, '').replace(/\/message$/, '');
  const url = m.card ? link(m.card) : null;
  const text = markdownText(m, link);
  return {
    url: `${u.origin}${path}/message${u.search}`,
    headers: { 'Content-Type': 'application/json', 'X-Gotify-Key': t.secret ?? '' },
    body: JSON.stringify({
      title: titleOf(m).slice(0, 250),
      message: text,
      priority: m.urgent ? 8 : 5,
      extras: {
        'client::display': { contentType: 'text/markdown' },
        ...(url ? { 'client::notification': { click: { url } } } : {}),
      },
    }),
  };
};

/**
 * Webhook: a versioned JSON body (documented in docs/NOTIFICATIONS.md; part of 1.x's promises).
 * With a secret, X-Belltower-Signature is "sha256=" + HMAC-SHA256(secret, "<timestamp>.<body>").
 */
const toWebhook: Format = (t, m, link, now) => {
  const ref = (c: CardInfo) => ({
    id: c.id,
    ticketNo: c.ticket_no,
    title: c.title,
    kind: c.kind,
    column: c.column_name,
    priority: c.priority ? PRIORITY_CODES[c.priority] : null,
    severity: c.severity ? SEVERITY_CODES[c.severity] : null,
    dueDate: c.due_date,
    url: link(c),
  });
  const body = JSON.stringify({
    version: 1,
    event: m.event,
    title: titleOf(m),
    message: m.heading,
    urgent: m.urgent,
    url: m.card ? link(m.card) : null,
    card: m.card ? ref(m.card) : null,
    ...(m.digest ? { digest: { overdue: m.digest.overdue.map(ref), dueToday: m.digest.dueToday.map(ref) } } : {}),
    sentAt: now.toISOString(),
  });
  const timestamp = String(Math.floor(now.getTime() / 1000));
  return {
    url: t.url,
    headers: {
      'Content-Type': 'application/json',
      'X-Belltower-Event': m.event,
      // The same id on every retry of this delivery, so a receiver can drop duplicates.
      'X-Belltower-Delivery': randomUUID(),
      'X-Belltower-Timestamp': timestamp,
      ...(t.secret ? { 'X-Belltower-Signature': `sha256=${createHmac('sha256', t.secret).update(`${timestamp}.${body}`).digest('hex')}` } : {}),
    },
    body,
  };
};

// Discord notifications through a webhook (Settings → Notifications). Nothing is sent unless a
// webhook is set. Events arrive through ctx.emit (inside the change's transaction), so handling is
// deferred and re-checks the card. Delivery: 10 s timeout, 2 retries, honouring Discord's 429s;
// the last result shows in Settings.

import { PRIORITIES, PRIORITY_LABELS, SEVERITIES, SEVERITY_LABELS, type Priority, type Severity } from '@tt/shared';
import { getSetting, setSetting, stmt } from '../db/connection';
import { localDateOf } from '../lib/localdate';
import { localTimeOf } from '../lib/tz';
import type { AppEvent, Ctx } from './context';
import { getDiscordSettings, getGeneralSettings, recordDelivery, type DiscordSettings } from './settings';

/** At or above the alert levels in Settings (P0 is index 0, S1 is index 0). */
export function isUrgent(s: Pick<DiscordSettings, 'alertPriority' | 'alertSeverity'>, priority: Priority | null, severity: Severity | null): boolean {
  return (
    (priority !== null && PRIORITIES.indexOf(priority) <= PRIORITIES.indexOf(s.alertPriority)) ||
    (severity !== null && SEVERITIES.indexOf(severity) <= SEVERITIES.indexOf(s.alertSeverity))
  );
}

function levels(c: { priority: Priority | null; severity: Severity | null }): string {
  return [c.priority ? PRIORITY_LABELS[c.priority] : null, c.severity ? SEVERITY_LABELS[c.severity] : null].filter(Boolean).join(' · ');
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
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

interface CardInfo {
  id: number;
  ticket_no: string | null;
  title: string;
  priority: Priority | null;
  severity: Severity | null;
  column_name: string;
  completed_at: string | null;
  deleted_at: string | null;
  due_date: string | null;
}

function cardInfo(ctx: Ctx, id: number): CardInfo | null {
  return (
    (stmt(
      ctx.db,
      `SELECT c.id, c.ticket_no, c.title, c.priority, c.severity, col.name AS column_name, c.completed_at, c.deleted_at, c.due_date
         FROM cards c JOIN columns col ON col.id = c.column_id WHERE c.id = ?`,
    ).get(id) as CardInfo | undefined) ?? null
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DiscordNotifier {
  constructor(
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly retryDelaysMs: number[] = [1000, 3000],
  ) {}

  private cardEmbed(ctx: Ctx, c: CardInfo, heading: string, color: number): Embed {
    const appUrl = getGeneralSettings(ctx).appUrl;
    const fields = [
      { name: 'Column', value: c.column_name, inline: true },
      ...(c.priority ? [{ name: 'Priority', value: PRIORITY_LABELS[c.priority], inline: true }] : []),
      ...(c.severity ? [{ name: 'Severity', value: SEVERITY_LABELS[c.severity], inline: true }] : []),
    ];
    return {
      title: `${c.ticket_no ? `${c.ticket_no} — ` : ''}${c.title}`.slice(0, 256),
      ...(appUrl ? { url: `${appUrl}/cards/${c.id}` } : {}),
      description: heading,
      color,
      fields,
    };
  }

  /** Reacts to an app event (call it deferred, after the change has committed). */
  async handle(ctx: Ctx, event: AppEvent): Promise<void> {
    const s = getDiscordSettings(ctx);
    if (!s.webhookUrl) return;
    const card = cardInfo(ctx, event.cardId);
    if (!card || card.deleted_at) return; // rolled back, or already trashed

    if (event.type === 'card_created') {
      const urgent = isUrgent(s, card.priority, card.severity);
      if (event.external && s.events.external) {
        await this.send(ctx, [this.cardEmbed(ctx, card, `New ticket from ${event.via ?? 'outside'}`, urgent ? COLOR.critical : COLOR.external)]);
      } else if (urgent && s.events.critical) {
        await this.send(ctx, [this.cardEmbed(ctx, card, `New urgent card (${levels(card)})`, COLOR.critical)]);
      }
    } else if (event.type === 'card_raised') {
      // Only when it *becomes* urgent, so editing an already-urgent card doesn't repeat the alert.
      const { from, to } = event;
      if (s.events.critical && !card.completed_at && !isUrgent(s, from.priority, from.severity) && isUrgent(s, to.priority, to.severity)) {
        await this.send(ctx, [this.cardEmbed(ctx, card, `Raised to ${levels(to)}`, COLOR.critical)]);
      }
    } else if (event.type === 'card_blocked' && s.events.blocked && !card.completed_at) {
      const blockers = event.blockerIds
        .map((id) => cardInfo(ctx, id))
        .filter((b): b is CardInfo => b !== null)
        .map((b) => `${b.ticket_no ?? `#${b.id}`} ${b.title}`)
        .join(', ');
      await this.send(ctx, [this.cardEmbed(ctx, card, `Blocked by ${blockers || 'an open card'}`, COLOR.blocked)]);
    }
  }

  /**
   * Once a day, at or after the configured local time: overdue and due-today cards. Called by the
   * 10-minute scheduler; remembers the day it last ran (even when there was nothing to send).
   */
  async dailyDigest(ctx: Ctx, now: Date): Promise<boolean> {
    const s = getDiscordSettings(ctx);
    if (!s.webhookUrl || !s.events.digest) return false;
    const today = localDateOf(now, ctx.tz);
    if (getSetting(ctx.db, 'discord_digest_last') === today) return false;
    if (localTimeOf(now.toISOString(), ctx.tz) < s.digestTime) return false;
    // Marked before sending so a slow send can't overlap the next check; un-marked if it fails.
    setSetting(ctx.db, 'discord_digest_last', today);
    const result = await this.sendDigest(ctx, now);
    if (!result.ok) setSetting(ctx.db, 'discord_digest_last', '');
    return result.ok;
  }

  /** The summary itself (Settings → Send summary now uses it too). Sent even when nothing is due. */
  async sendDigest(ctx: Ctx, now: Date): Promise<{ ok: boolean; message: string }> {
    const today = localDateOf(now, ctx.tz);
    const rows = stmt(
      ctx.db,
      `SELECT c.id, c.ticket_no, c.title, c.priority, c.severity, col.name AS column_name, c.completed_at, c.deleted_at, c.due_date
         FROM cards c JOIN columns col ON col.id = c.column_id
        WHERE c.deleted_at IS NULL AND c.archived_at IS NULL AND c.completed_at IS NULL AND c.due_date IS NOT NULL AND c.due_date <= ?
        ORDER BY c.due_date, c.id LIMIT 50`,
    ).all(today) as CardInfo[];
    const appUrl = getGeneralSettings(ctx).appUrl;
    const line = (c: CardInfo) => {
      const name = `${c.ticket_no ?? `#${c.id}`} — ${c.title}`.slice(0, 120);
      return `• ${appUrl ? `[${name}](${appUrl}/cards/${c.id})` : name}`;
    };
    const overdue = rows.filter((c) => c.due_date! < today);
    const dueToday = rows.filter((c) => c.due_date === today);
    const fields = [
      ...(overdue.length ? [{ name: `Overdue (${overdue.length})`, value: overdue.map(line).join('\n').slice(0, 1024) }] : []),
      ...(dueToday.length ? [{ name: `Due today (${dueToday.length})`, value: dueToday.map(line).join('\n').slice(0, 1024) }] : []),
    ];
    return this.send(ctx, [
      fields.length
        ? { title: 'Tower Tracker: today', color: COLOR.digest, fields }
        : { title: 'Tower Tracker: today', color: COLOR.test, description: 'Nothing overdue or due today.' },
    ]);
  }

  /** Settings → Notifications → Send test. */
  async sendTest(ctx: Ctx): Promise<{ ok: boolean; message: string }> {
    if (!getDiscordSettings(ctx).webhookUrl) return { ok: false, message: 'No webhook is set' };
    return this.send(ctx, [{ title: 'Tower Tracker test message', description: 'Notifications are working.', color: COLOR.test }]);
  }

  private async send(ctx: Ctx, embeds: Embed[]): Promise<{ ok: boolean; message: string }> {
    const url = getDiscordSettings(ctx).webhookUrl;
    if (!url) return { ok: false, message: 'No webhook is set' };
    const body = JSON.stringify({ username: 'Tower Tracker', embeds, allowed_mentions: { parse: [] } });
    let last = 'Not sent';
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          recordDelivery(ctx, true, 'Delivered');
          return { ok: true, message: 'Delivered' };
        }
        last = `Discord answered ${res.status}`;
        // 4xx other than 429: the webhook is wrong or deleted; retrying won't help.
        if (res.status !== 429 && res.status < 500) break;
        const retryAfter = Number(res.headers.get('retry-after'));
        if (attempt < this.retryDelaysMs.length) {
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : this.retryDelaysMs[attempt]!);
        }
      } catch (err) {
        last = `Couldn’t reach Discord: ${(err as Error).message}`;
        if (attempt < this.retryDelaysMs.length) await sleep(this.retryDelaysMs[attempt]!);
      }
    }
    recordDelivery(ctx, false, last);
    return { ok: false, message: last };
  }
}

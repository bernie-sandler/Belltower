// Automation intake (POST /api/v1/cards and the Uptime Kuma hook): a card in the card-import format,
// plus a `dedupeKey` so repeat alerts update the open ticket instead of piling up, and an `event`
// so a recovery can note (and, if the token may, complete) it.

import type { CardDetail } from '@tt/shared';
import { stmt } from '../db/connection';
import { AppError, badRequest } from '../errors';
import { createImported, prepareImport } from './cardImport';
import { completeCard, getCard } from './cards';
import { tx, type Ctx } from './context';
import type { TokenIdentity } from './tokens';
import { addWorklog } from './worklog';

export type IntakeStatus = 'created' | 'updated' | 'resolved' | 'recovered' | 'ignored';

export interface IntakeResult {
  status: IntakeStatus;
  card: { id: number; ticketNo: string | null; title: string; columnId: number; completedAt: string | null } | null;
}

const brief = (c: CardDetail): IntakeResult['card'] => ({
  id: c.id,
  ticketNo: c.ticketNo,
  title: c.title,
  columnId: c.columnId,
  completedAt: c.completedAt,
});

/** The newest open ticket an automation opened with this key. */
function openCardFor(ctx: Ctx, key: string): number | null {
  return (
    (stmt(
      ctx.db,
      `SELECT id FROM cards WHERE source = 'api' AND source_ref = ? AND deleted_at IS NULL AND archived_at IS NULL
         AND completed_at IS NULL ORDER BY id DESC LIMIT 1`,
    )
      .pluck()
      .get(key) as number | undefined) ?? null
  );
}

function firstLines(text: string, max = 500): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function intakeCard(ctx: Ctx, token: TokenIdentity, body: unknown): IntakeResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('validation', 'Send one card as a JSON object');
  const { dedupeKey: rawKey, event: rawEvent, ...card } = body as Record<string, unknown>;
  const dedupeKey = typeof rawKey === 'string' && rawKey.trim() ? rawKey.trim().slice(0, 200) : null;
  const event = rawEvent ?? 'problem';
  if (event !== 'problem' && event !== 'resolved') throw badRequest('validation', '"event" must be "problem" or "resolved"');
  if (event === 'resolved' && !dedupeKey) throw badRequest('validation', '"event": "resolved" needs the same "dedupeKey" as the problem');
  const via = `API token “${token.name}”`;

  return tx(ctx, () => {
    const existing = dedupeKey ? openCardFor(ctx, dedupeKey) : null;

    if (event === 'resolved') {
      if (existing === null) return { status: 'ignored' as const, card: null };
      const note = typeof card.description === 'string' && card.description.trim() ? `\n\n${firstLines(card.description)}` : '';
      addWorklog(ctx, existing, { bodyMd: `Recovered (reported by ${via}).${note}` });
      if (token.canComplete) {
        try {
          return { status: 'resolved' as const, card: brief(completeCard(ctx, existing, { includeChildren: false }).card) };
        } catch (err) {
          // Blocked by an open card: leave it open; the work log says it recovered.
          if (!(err instanceof AppError && err.code === 'blocked')) throw err;
        }
      }
      return { status: 'recovered' as const, card: brief(getCard(ctx, existing)) };
    }

    if (existing !== null) {
      const desc = typeof card.description === 'string' && card.description.trim() ? `\n\n${firstLines(card.description)}` : '';
      addWorklog(ctx, existing, { bodyMd: `Seen again (reported by ${via}).${desc}` });
      return { status: 'updated' as const, card: brief(getCard(ctx, existing)) };
    }

    const items = prepareImport(ctx, card);
    if (items.length !== 1) throw badRequest('validation', 'Send one card (nested "tickets" aren’t supported here)');
    const item = items[0]!;
    if (!item.ok) throw new AppError(400, 'validation', item.errors.join('; ') || 'Invalid card', { errors: item.errors });
    const [id] = createImported(ctx, items, { via, ...(dedupeKey ? { sourceRef: dedupeKey } : {}), external: true });
    return { status: 'created' as const, card: brief(getCard(ctx, id!)) };
  });
}

/** Uptime Kuma's webhook body (the parts we use). */
interface KumaBody {
  heartbeat?: { status?: number; msg?: string; time?: string } | null;
  monitor?: { id?: number | string; name?: string; url?: string | null; hostname?: string | null } | null;
  msg?: string;
}

/**
 * Maps an Uptime Kuma notification onto intakeCard: down → open (or update) a ticket per monitor,
 * up → recovered. `defaults` come from the hook URL's query (labels, priority, severity, column).
 * Kuma's "Test" button sends no monitor; that's answered without creating anything.
 */
export function intakeUptimeKuma(
  ctx: Ctx,
  token: TokenIdentity,
  body: KumaBody,
  defaults: Record<string, string>,
): IntakeResult & { test?: boolean } {
  const monitor = body.monitor;
  const status = body.heartbeat?.status;
  if (!monitor || monitor.id === undefined || status === undefined) return { status: 'ignored', card: null, test: true };
  if (status !== 0 && status !== 1) return { status: 'ignored', card: null }; // pending / maintenance

  const name = String(monitor.name ?? `Monitor ${monitor.id}`).slice(0, 200);
  const target = monitor.url || monitor.hostname || '';
  const msg = body.heartbeat?.msg || body.msg || '';
  const lines = [
    msg ? `**Uptime Kuma:** ${msg}` : '',
    target ? `**Target:** ${target}` : '',
    body.heartbeat?.time ? `**Time:** ${body.heartbeat.time}` : '',
  ].filter(Boolean);

  return intakeCard(ctx, token, {
    title: `${name} is down`,
    description: lines.join('\n\n'),
    priority: defaults.priority || 'P1',
    ...(defaults.severity ? { severity: defaults.severity } : {}),
    ...(defaults.column ? { column: defaults.column } : {}),
    ...(defaults.labels ? { labels: defaults.labels } : {}),
    dedupeKey: `uptime-kuma:${monitor.id}`,
    event: status === 0 ? 'problem' : 'resolved',
  });
}

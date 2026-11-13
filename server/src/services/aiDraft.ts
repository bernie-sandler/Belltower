// Add ticket: Claude turns a plain-words problem description into a draft card (title, Markdown
// details, impact/urgency → priority, severity, labels, checklist, plus the card type, an open
// work card it belongs under and links to open cards). Nothing is saved here; the user reviews the
// draft and creates the card through POST /api/tickets.
//
// "Describe several issues" (draftTickets): notes or logs in, several cards out, written in the
// card-import format and checked by the importer's preview; the user creates them from there.
//
// The network call sits behind TicketDrafter so tests (and installs without ANTHROPIC_API_KEY)
// never reach Anthropic.

import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { BulkDraft, DraftCardRef, LinkDirection, Level, Severity, TicketDraft } from '@tt/shared';
import {
  LEVELS,
  LIMITS,
  LocalDate,
  PRIORITY_MATRIX,
  SEVERITIES,
  SEVERITY_CODES,
  SEVERITY_DESCRIPTIONS,
  SEVERITY_LABELS,
} from '@tt/shared';
import { z } from 'zod';
import { stmt } from '../db/connection';
import { AppError } from '../errors';
import { localDateOf } from '../lib/localdate';
import { CARD_IMPORT_FORMAT, importCards } from './cardImport';
import type { Ctx } from './context';
import { listLabels } from './labels';
import { visibleSql } from './scope';

/**
 * What Claude must return. Plain strings only: the SDK passes enums and limits to the model as
 * hints rather than hard constraints, so draftTicket normalises and clamps everything afterwards.
 */
export const DraftOutput = z.object({
  title: z.string(),
  description: z.string(),
  impact: z.string().describe(LEVELS.join(' | ')),
  urgency: z.string().describe(LEVELS.join(' | ')),
  severity: z.string().describe(SEVERITIES.join(' | ')),
  priorityReason: z.string(),
  severityReason: z.string(),
  labels: z.array(z.string()),
  checklist: z.array(z.string()),
  dueDate: z.string().nullable(),
  kind: z.string().describe('ticket | work'),
  kindReason: z.string(),
  partOf: z.string().nullable().describe('reference of an open work card from the list, or null'),
  links: z.array(
    z.object({
      type: z.string().describe('blocks | blockedBy | relatedTo'),
      card: z.string().describe('reference of an open card from the list'),
      reason: z.string(),
    }),
  ),
});
export type DraftOutput = z.infer<typeof DraftOutput>;

/** "Describe several issues": cards in (roughly) the card-import format. */
export const BulkOutput = z.object({
  cards: z.array(
    z.object({
      ref: z.string().describe('short unique id within this answer, e.g. "a", "b"'),
      type: z.string().describe('ticket | work'),
      title: z.string(),
      description: z.string(),
      impact: z.string().describe(LEVELS.join(' | ')),
      urgency: z.string().describe(LEVELS.join(' | ')),
      severity: z.string().describe(SEVERITIES.join(' | ')),
      labels: z.array(z.string()),
      checklist: z.array(z.string()),
      dueDate: z.string().nullable(),
      partOf: z.string().nullable().describe('ref of a work card in this answer, or reference of an open work card, or null'),
      blocks: z.array(z.string()),
      blockedBy: z.array(z.string()),
      relatedTo: z.array(z.string()),
    }),
  ),
});
export type BulkOutput = z.infer<typeof BulkOutput>;

export interface TicketDrafter {
  readonly model: string;
  /** Returns Claude's answer in the given shape, or throws an AppError the UI can show. */
  complete<T>(system: string, user: string, schema: z.ZodType<T>): Promise<T>;
}

const SYSTEM_PROMPT = `You triage problems for a single-person homelab built around an Unraid server named "Tower" \
(Docker containers, VMs, storage pools, networking, a reverse proxy, Tailscale). The owner describes a problem in \
their own words; you turn it into one well-formed ticket for their issue tracker.

Rate two things, each high, medium or low:
- impact: how much of the homelab and how many people are affected (high = core services or data at risk; \
low = cosmetic or one rarely used thing).
- urgency: how soon it has to be handled (high = now or today; medium = this week; low = whenever).
The tracker derives priority P0-P3 from impact x urgency, so rate them honestly and independently.

Severity is how bad the breakage itself is:
${SEVERITIES.map((s) => `- ${s} (${SEVERITY_LABELS[s]}): ${SEVERITY_DESCRIPTIONS[s]}`).join('\n')}

Write the ticket:
- title: a short, specific summary (under 80 characters), no trailing period.
- description: Markdown with the sections "### Symptoms", "### Details" and "### Next steps". Keep the owner's \
facts, exact error messages and versions (error text in code blocks). Do not invent facts, logs or causes; when \
something is a guess, say so.
- checklist: 2-8 concrete diagnostic or fix steps, each one short line, in the order to do them.
- labels: only names from the provided label list that clearly fit; an empty list is fine.
- priorityReason / severityReason: one short sentence each, explaining the rating.
- dueDate: YYYY-MM-DD only when the owner states or clearly implies a deadline, otherwise null.

Place it among the open cards listed (each with a reference like 261027-3 or #12):
- kind: "work" only when the text describes a piece of work made of several separate issues or steps (a \
project, an upgrade, a migration); otherwise "ticket". kindReason: one short sentence.
- partOf: for a ticket, the reference of an open work card it clearly belongs to, otherwise null.
- links: only open cards the text clearly connects to; type "blocks" (this new card must be done before that \
one), "blockedBy" (this one can't be done until that one is) or "relatedTo" (same problem area, worth seeing \
together). At most 5, each with a one-sentence reason. An empty list is normal; never guess.`;

const BULK_PROMPT = `You triage problems for a single-person homelab built around an Unraid server named "Tower" \
(Docker containers, VMs, storage pools, networking, a reverse proxy, Tailscale). The owner pastes notes, a list or \
logs that describe several issues; you split them into separate, well-formed tickets for their issue tracker.

- One card per distinct issue; merge duplicates. At most 20 cards. Keep the owner's order.
- When several issues are steps of one piece of work (an upgrade, a migration), add a card with type "work" for \
it and set the tickets' partOf to its ref. An open work card from the list may be used instead (its reference).
- Rate impact and urgency (high, medium or low) independently: impact is how much breaks and for whom, urgency \
how soon it must be handled (high = today, medium = this week, low = whenever).
- Severity is how bad the breakage itself is:
${SEVERITIES.map((s) => `  - ${s} (${SEVERITY_LABELS[s]}): ${SEVERITY_DESCRIPTIONS[s]}`).join('\n')}
- title: short and specific (under 80 characters), no trailing period.
- description: Markdown with "### Symptoms", "### Details" and "### Next steps". Keep exact error messages, \
versions and log lines (in code blocks). Don't invent facts; mark guesses as guesses.
- checklist: 0-8 short, concrete steps in order.
- labels: only names from the provided label list that clearly fit.
- dueDate: YYYY-MM-DD only for a stated or clearly implied deadline, otherwise null.
- blocks / blockedBy / relatedTo: refs of other cards in this answer, or references of open cards from the list, \
only when the text clearly says one depends on or relates to another. Usually empty.`;

/** Open cards Claude may refer to: work cards (for partOf) and recently updated open cards (for links). */
interface OpenCardRef extends DraftCardRef {
  kind: string;
  column: string;
}

/**
 * Only cards the person can see: their titles go to Anthropic, and the draft's work card and links
 * are picked from these lists, so a hidden card can't come back in the answer either.
 */
function openCards(ctx: Ctx, kind: 'work' | 'any', limit: number): OpenCardRef[] {
  return stmt(
    ctx.db,
    `SELECT c.id, c.ticket_no AS ticketNo, c.title, c.kind, col.name AS "column" FROM cards c JOIN columns col ON col.id = c.column_id
      WHERE c.deleted_at IS NULL AND c.archived_at IS NULL AND c.completed_at IS NULL ${kind === 'work' ? "AND c.kind = 'work'" : ''}
        AND ${visibleSql(ctx)}
      ORDER BY c.updated_at DESC, c.id DESC LIMIT ${limit}`,
  ).all() as OpenCardRef[];
}

const refOf = (c: DraftCardRef) => c.ticketNo ?? `#${c.id}`;

function listing(cards: OpenCardRef[]): string {
  return cards.length
    ? cards.map((c) => `- ${refOf(c)} [${c.column}${c.kind === 'work' ? ', work card' : ''}] ${c.title}`).join('\n')
    : '(none)';
}

/** Finds a card by the reference Claude gave ("261027-3", "#12", or with the title after it). */
function findRef<T extends DraftCardRef>(cards: T[], raw: string | null | undefined): T | undefined {
  const token = raw?.trim().split(/\s+/, 1)[0]?.replace(/[.,;:]$/, '').toLowerCase();
  return token ? cards.find((c) => refOf(c).toLowerCase() === token) : undefined;
}

function buildUserMessage(ctx: Ctx, text: string, work: OpenCardRef[], open: OpenCardRef[], what = 'Problem description'): string {
  const labels = listLabels(ctx).map((l) => l.name);
  const today = localDateOf(ctx.clock.now(), ctx.tz);
  return [
    `Today is ${today} (time zone ${ctx.tz}).`,
    `Labels available: ${labels.length ? labels.map((n) => JSON.stringify(n)).join(', ') : '(none)'}`,
    '',
    'Open work cards:',
    listing(work),
    '',
    'Other open cards (most recently updated first):',
    listing(open.filter((c) => c.kind !== 'work')),
    '',
    `${what}:`,
    '<description>',
    text,
    '</description>',
  ].join('\n');
}

function toLevel(raw: string): Level {
  const v = raw.trim().toLowerCase();
  return (LEVELS as readonly string[]).includes(v) ? (v as Level) : 'medium';
}

/** Accepts "major", "S2" or "S2 Major"; anything else counts as minor. */
function toSeverity(raw: string): Severity {
  const v = raw.trim().toLowerCase();
  return (
    SEVERITIES.find((s) => v === s || v === SEVERITY_CODES[s].toLowerCase() || v === SEVERITY_LABELS[s].toLowerCase()) ??
    'minor'
  );
}

const clamp = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s);

const LINK_TYPES: Record<string, LinkDirection> = {
  blocks: 'blocks',
  blockedby: 'blocked_by',
  blocked_by: 'blocked_by',
  relatedto: 'relates',
  related: 'relates',
  relates: 'relates',
};

const brief = (c: DraftCardRef): DraftCardRef => ({ id: c.id, ticketNo: c.ticketNo, title: c.title });

/** Asks the drafter for a draft and fits it to the tracker's rules. */
export async function draftTicket(ctx: Ctx, drafter: TicketDrafter, text: string): Promise<TicketDraft> {
  const work = openCards(ctx, 'work', 50);
  const open = openCards(ctx, 'any', 100);
  const out = await drafter.complete(SYSTEM_PROMPT, buildUserMessage(ctx, text, work, open), DraftOutput);

  const byName = new Map(listLabels(ctx).map((l) => [l.name.toLowerCase(), l.id]));
  const labelIds = [...new Set(out.labels.map((n) => byName.get(n.trim().toLowerCase())).filter((id) => id !== undefined))];
  const checklist = out.checklist
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((s) => clamp(s, LIMITS.checklistItem));
  const title = clamp(out.title.trim().replace(/\s+/g, ' '), LIMITS.cardTitle) || clamp(text.split('\n', 1)[0]!.trim(), LIMITS.cardTitle);

  const impact = toLevel(out.impact);
  const urgency = toLevel(out.urgency);
  return {
    title,
    description: clamp(out.description.trim(), LIMITS.description),
    impact,
    urgency,
    priority: PRIORITY_MATRIX[impact][urgency],
    severity: toSeverity(out.severity),
    priorityReason: clamp(out.priorityReason.trim(), 300),
    severityReason: clamp(out.severityReason.trim(), 300),
    labelIds,
    checklist,
    dueDate: out.dueDate && LocalDate.safeParse(out.dueDate).success ? out.dueDate : null,
    ...placement(out, work, open),
  };
}

/** Type, work card and links: only references to cards that exist and are open are kept. */
function placement(
  out: DraftOutput,
  work: OpenCardRef[],
  open: OpenCardRef[],
): Pick<TicketDraft, 'kind' | 'kindReason' | 'parent' | 'links'> {
  const kind = out.kind?.trim().toLowerCase().startsWith('work') ? 'work' : 'ticket';
  const parent = kind === 'ticket' ? findRef(work, out.partOf) : undefined;
  const all = [...open, ...work.filter((w) => !open.some((o) => o.id === w.id))];
  const links: TicketDraft['links'] = [];
  for (const l of out.links ?? []) {
    const direction = LINK_TYPES[l.type.trim().toLowerCase().replace(/[\s-]/g, '')];
    const card = findRef(all, l.card);
    if (!direction || !card || card.id === parent?.id || links.some((x) => x.card.id === card.id)) continue;
    links.push({ direction, card: brief(card), reason: clamp(l.reason.trim(), 300) });
    if (links.length === 5) break;
  }
  return { kind, kindReason: clamp(out.kindReason?.trim() ?? '', 300), parent: parent ? brief(parent) : null, links };
}

/**
 * "Describe several issues": Claude splits the text into cards in the card-import format, and the
 * importer's preview (nothing saved) checks them. The client creates them with POST
 * /api/import/cards and the returned `cards` once the user has reviewed the preview.
 */
export async function draftTickets(ctx: Ctx, drafter: TicketDrafter, text: string): Promise<BulkDraft> {
  const work = openCards(ctx, 'work', 50);
  const open = openCards(ctx, 'any', 100);
  const out = await drafter.complete(BULK_PROMPT, buildUserMessage(ctx, text, work, open, 'Notes'), BulkOutput);
  const known = [...open, ...work];
  const labels = new Map(listLabels(ctx).map((l) => [l.name.toLowerCase(), l.name]));
  // Open cards are named by ticket number in the import format; refs within the answer stay refs.
  const target = (raw: string) => {
    const card = findRef(known, raw);
    return card ? refOf(card) : raw.trim();
  };
  const list = (v: string[]) => [...new Set(v.map(target).filter(Boolean))];
  const cards = out.cards.slice(0, 30).map((c) => {
    const impact = toLevel(c.impact);
    const urgency = toLevel(c.urgency);
    const card: Record<string, unknown> = {
      ...(c.ref.trim() ? { ref: c.ref.trim() } : {}),
      type: c.type.trim().toLowerCase().startsWith('work') ? 'work' : 'ticket',
      title: clamp(c.title.trim().replace(/\s+/g, ' '), LIMITS.cardTitle),
      description: clamp(c.description.trim(), LIMITS.description),
      priority: PRIORITY_MATRIX[impact][urgency],
      severity: toSeverity(c.severity),
    };
    // Only existing labels: the import would create made-up ones.
    const known = [...new Set(c.labels.map((n) => labels.get(n.trim().toLowerCase())).filter((n) => n !== undefined))];
    if (known.length) card.labels = known;
    const checklist = c.checklist.map((s) => s.trim()).filter(Boolean).slice(0, 20);
    if (checklist.length) card.checklist = checklist;
    if (c.dueDate && LocalDate.safeParse(c.dueDate).success) card.due = c.dueDate;
    if (c.partOf?.trim() && card.type === 'ticket') card.partOf = target(c.partOf);
    for (const [key, v] of [
      ['blocks', c.blocks],
      ['blockedBy', c.blockedBy],
      ['relatedTo', c.relatedTo],
    ] as const) {
      if (v.length) card[key] = list(v);
    }
    return card;
  });
  if (cards.length === 0) throw new AppError(422, 'ai_empty', 'Claude didn’t find any issues in that text.');
  return { cards, preview: importCards(ctx, { format: CARD_IMPORT_FORMAT, cards }, true) };
}

/** Turns SDK failures into messages that make sense in the Add ticket dialog. */
export function mapAnthropicError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new AppError(502, 'ai_bad_key', 'Claude rejected the API key. Check ANTHROPIC_API_KEY in .env.');
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new AppError(503, 'ai_rate_limited', 'Claude is rate limiting this API key. Try again in a minute.');
  }
  if (err instanceof Anthropic.APIConnectionError) {
    // Includes APIConnectionTimeoutError.
    return new AppError(503, 'ai_unreachable', "Couldn't reach Claude. Check the server's internet connection.");
  }
  if (err instanceof Anthropic.NotFoundError || err instanceof Anthropic.BadRequestError) {
    return new AppError(502, 'ai_failed', `Claude refused the request: ${err.message}`);
  }
  if (err instanceof Anthropic.APIError) {
    return new AppError(503, 'ai_unavailable', 'Claude is temporarily unavailable. Try again shortly.');
  }
  return new AppError(502, 'ai_failed', 'Drafting with Claude failed.');
}

/** `model` is read on every call, so a model chosen in Settings applies straight away. */
export function createClaudeDrafter(apiKey: string, model: () => string): TicketDrafter {
  let client: Anthropic | null = null;
  return {
    get model() {
      return model();
    },
    async complete<T>(system: string, user: string, schema: z.ZodType<T>): Promise<T> {
      client ??= new Anthropic({ apiKey, timeout: 90_000, maxRetries: 1 });
      let msg;
      try {
        msg = await client.beta.messages.parse({
          model: model(),
          max_tokens: 8000,
          // On a policy decline, let the API retry on its default fallback model.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort: 'medium', format: betaZodOutputFormat(schema) },
          system,
          messages: [{ role: 'user', content: user }],
        });
      } catch (err) {
        throw mapAnthropicError(err);
      }
      if (msg.stop_reason === 'refusal') {
        throw new AppError(422, 'ai_refused', 'Claude declined to draft this ticket. Fill it in by hand instead.');
      }
      if (msg.stop_reason === 'max_tokens' || !msg.parsed_output) {
        throw new AppError(502, 'ai_failed', 'Claude returned an incomplete draft. Try again.');
      }
      return msg.parsed_output as T;
    },
  };
}

// Add ticket: Claude turns a plain-words problem description into a draft card (title, Markdown
// details, impact/urgency → priority, severity, labels, checklist). Nothing is saved here; the
// user reviews the draft and creates the card through POST /api/tickets.
//
// The network call sits behind TicketDrafter so tests (and installs without ANTHROPIC_API_KEY)
// never reach Anthropic.

import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { Level, Severity, TicketDraft } from '@tt/shared';
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
import { AppError } from '../errors';
import { localDateOf } from '../lib/localdate';
import type { Ctx } from './context';
import { listLabels } from './labels';

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
});
export type DraftOutput = z.infer<typeof DraftOutput>;

export interface TicketDrafter {
  readonly model: string;
  /** Returns Claude's structured answer, or throws an AppError the UI can show. */
  complete(system: string, user: string): Promise<DraftOutput>;
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
- dueDate: YYYY-MM-DD only when the owner states or clearly implies a deadline, otherwise null.`;

function buildUserMessage(ctx: Ctx, text: string): string {
  const labels = listLabels(ctx).map((l) => l.name);
  const today = localDateOf(ctx.clock.now(), ctx.tz);
  return [
    `Today is ${today} (time zone ${ctx.tz}).`,
    `Labels available: ${labels.length ? labels.map((n) => JSON.stringify(n)).join(', ') : '(none)'}`,
    '',
    'Problem description:',
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

/** Asks the drafter for a draft and fits it to the tracker's rules. */
export async function draftTicket(ctx: Ctx, drafter: TicketDrafter, text: string): Promise<TicketDraft> {
  const out = await drafter.complete(SYSTEM_PROMPT, buildUserMessage(ctx, text));

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
  };
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
    async complete(system, user) {
      client ??= new Anthropic({ apiKey, timeout: 90_000, maxRetries: 1 });
      let msg;
      try {
        msg = await client.beta.messages.parse({
          model: model(),
          max_tokens: 8000,
          // On a policy decline, let the API retry on its default fallback model.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort: 'medium', format: betaZodOutputFormat(DraftOutput) },
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
      return msg.parsed_output;
    },
  };
}

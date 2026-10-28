// Add ticket: Claude drafting (when ANTHROPIC_API_KEY is set), "Describe several issues", and
// creating the reviewed card.

import type { AiStatus } from '@tt/shared';
import { CreateTicketBody, DraftTicketBody } from '@tt/shared';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app';
import { AppError } from '../../errors';
import { draftTicket, draftTickets } from '../../services/aiDraft';
import { createCard, getCard } from '../../services/cards';
import { tx } from '../../services/context';
import { createLink } from '../../services/links';
import { parse } from '../util';

/** Drafts cost money; cap them so a stuck client can't run up the bill. */
export const DRAFT_LIMIT = { max: 20, windowMs: 10 * 60 * 1000 };

export function registerTicketRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { ctx, ai } = deps;
  const recent: number[] = [];

  app.get('/api/ai/status', async (): Promise<AiStatus> => ({ enabled: ai !== null, model: ai?.model ?? null }));

  /** Drafts cost money: one bulk draft counts as one, like a single one. */
  function countDraft(): void {
    const now = ctx.clock.now().getTime();
    while (recent.length && recent[0]! <= now - DRAFT_LIMIT.windowMs) recent.shift();
    if (recent.length >= DRAFT_LIMIT.max) {
      const retryAfterSec = Math.ceil((recent[0]! + DRAFT_LIMIT.windowMs - now) / 1000);
      throw new AppError(429, 'ai_draft_limit', `Too many drafts. Try again in ${Math.ceil(retryAfterSec / 60)} min.`, {
        retryAfterSec,
      });
    }
    recent.push(now);
  }

  for (const [path, run] of [
    ['/api/ai/draft', draftTicket],
    ['/api/ai/draft-many', draftTickets],
  ] as const) {
    app.post(path, async (req) => {
      if (!ai) throw new AppError(503, 'ai_disabled', 'Claude drafting is off (no ANTHROPIC_API_KEY).');
      const { text } = parse(DraftTicketBody, req.body);
      countDraft();
      try {
        return await run(ctx, ai, text);
      } catch (err) {
        if (err instanceof AppError) req.log.warn(`Claude draft failed: ${err.code}: ${err.message}`);
        throw err;
      }
    });
  }

  app.post('/api/tickets', async (req, reply) => {
    const { checklist, aiDrafted, links, ...body } = parse(CreateTicketBody, req.body);
    // All or nothing: a link that can't be made (e.g. it would block a done card) undoes the card.
    const card = tx(ctx, () => {
      const created = createCard(
        ctx,
        { ...body, checklists: checklist?.length ? [{ title: 'Checklist', items: checklist }] : undefined },
        { source: 'manual', via: aiDrafted ? 'Add ticket (Claude draft)' : 'Add ticket' },
      );
      for (const l of links ?? []) createLink(ctx, created.id, l.cardId, l.direction);
      return links?.length ? getCard(ctx, created.id) : created;
    });
    return reply.status(201).send(card);
  });
}

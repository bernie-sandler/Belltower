// Add ticket: Claude drafting (when ANTHROPIC_API_KEY is set) and creating the reviewed card.

import type { AiStatus } from '@tt/shared';
import { CreateTicketBody, DraftTicketBody } from '@tt/shared';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app';
import { AppError } from '../../errors';
import { draftTicket } from '../../services/aiDraft';
import { createCard } from '../../services/cards';
import { parse } from '../util';

/** Drafts cost money; cap them so a stuck client can't run up the bill. */
export const DRAFT_LIMIT = { max: 20, windowMs: 10 * 60 * 1000 };

export function registerTicketRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { ctx, ai } = deps;
  const recent: number[] = [];

  app.get('/api/ai/status', async (): Promise<AiStatus> => ({ enabled: ai !== null, model: ai?.model ?? null }));

  app.post('/api/ai/draft', async (req) => {
    if (!ai) throw new AppError(503, 'ai_disabled', 'Claude drafting is off (no ANTHROPIC_API_KEY).');
    const { text } = parse(DraftTicketBody, req.body);

    const now = ctx.clock.now().getTime();
    while (recent.length && recent[0]! <= now - DRAFT_LIMIT.windowMs) recent.shift();
    if (recent.length >= DRAFT_LIMIT.max) {
      const retryAfterSec = Math.ceil((recent[0]! + DRAFT_LIMIT.windowMs - now) / 1000);
      throw new AppError(429, 'ai_draft_limit', `Too many drafts. Try again in ${Math.ceil(retryAfterSec / 60)} min.`, {
        retryAfterSec,
      });
    }
    recent.push(now);

    try {
      return await draftTicket(ctx, ai, text);
    } catch (err) {
      if (err instanceof AppError) req.log.warn(`Claude draft failed: ${err.code}: ${err.message}`);
      throw err;
    }
  });

  app.post('/api/tickets', async (req, reply) => {
    const { checklist, aiDrafted, ...body } = parse(CreateTicketBody, req.body);
    const card = createCard(
      ctx,
      { ...body, checklists: checklist?.length ? [{ title: 'Checklist', items: checklist }] : undefined },
      { source: 'manual', via: aiDrafted ? 'Add ticket (Claude draft)' : 'Add ticket' },
    );
    return reply.status(201).send(card);
  });
}

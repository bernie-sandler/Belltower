import { CalendarQuery, SearchQuery, SimilarQuery, TemplateBody, UpdateTemplateBody } from '@tt/shared';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app';
import { calendarItems } from '../../services/calendar';
import { getCardRow } from '../../services/cards';
import {
  createTemplate,
  deleteTemplate,
  getTemplate,
  listTemplates,
  runDueTemplates,
  runTemplateNow,
  updateTemplate,
} from '../../services/recurring';
import { searchCards, similarCards } from '../../services/search';
import { idParam, parse } from '../util';

export function registerPhase3Routes(app: FastifyInstance, deps: AppDeps): void {
  // A template that is due right away (e.g. resumed on its day) shouldn't wait for the next tick.
  // Cards it makes come from the template, not from the person who saved it (like the timer's).
  const tick = () => {
    try {
      runDueTemplates(deps.baseCtx);
    } catch (err) {
      app.log.error(err as Error, 'Recurring templates run failed');
    }
  };

  app.get('/api/search', async (req) => searchCards(req.ctx, parse(SearchQuery, req.query)));

  // "Seen this before?": finished tickets like this card, or like a ticket being written (Add ticket).
  app.get('/api/cards/:id/similar', async (req) => {
    const card = getCardRow(req.ctx, idParam(req));
    if (card.kind !== 'ticket' || card.deleted_at) return [];
    return similarCards(req.ctx, { title: card.title, description: card.description_md, excludeId: card.id });
  });
  app.get('/api/similar', async (req) => similarCards(req.ctx, parse(SimilarQuery, req.query)));

  app.get('/api/calendar', async (req) => {
    const q = parse(CalendarQuery, req.query);
    return calendarItems(req.ctx, q.from, q.to);
  });

  app.get('/api/templates', async (req) => listTemplates(req.ctx));
  app.get('/api/templates/:id', async (req) => getTemplate(req.ctx, idParam(req)));
  app.post('/api/templates', async (req, reply) => {
    const t = createTemplate(req.ctx, parse(TemplateBody, req.body));
    tick();
    return reply.status(201).send(getTemplate(req.ctx, t.id));
  });
  app.patch('/api/templates/:id', async (req) => {
    const id = idParam(req);
    updateTemplate(req.ctx, id, parse(UpdateTemplateBody, req.body));
    tick();
    return getTemplate(req.ctx, id);
  });
  app.delete('/api/templates/:id', async (req, reply) => {
    deleteTemplate(req.ctx, idParam(req));
    return reply.status(204).send();
  });
  /** "Create now". 409 open_instance (with cardId) while a card from it is open, unless ?force=1. */
  app.post('/api/templates/:id/run', async (req, reply) => {
    const force = (req.query as { force?: string }).force === '1';
    return reply.status(201).send(runTemplateNow(req.ctx, idParam(req), force));
  });
}

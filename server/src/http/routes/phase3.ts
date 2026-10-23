import { CalendarQuery, SearchQuery, TemplateBody, UpdateTemplateBody } from '@tt/shared';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app';
import { calendarItems } from '../../services/calendar';
import {
  createTemplate,
  deleteTemplate,
  getTemplate,
  listTemplates,
  runDueTemplates,
  runTemplateNow,
  updateTemplate,
} from '../../services/recurring';
import { searchCards } from '../../services/search';
import { idParam, parse } from '../util';

export function registerPhase3Routes(app: FastifyInstance, deps: AppDeps): void {
  const { ctx } = deps;

  // A template that is due right away (e.g. resumed on its day) shouldn't wait for the next tick.
  const tick = () => {
    try {
      runDueTemplates(ctx);
    } catch (err) {
      app.log.error(err as Error, 'Recurring templates run failed');
    }
  };

  app.get('/api/search', async (req) => searchCards(ctx, parse(SearchQuery, req.query)));

  app.get('/api/calendar', async (req) => {
    const q = parse(CalendarQuery, req.query);
    return calendarItems(ctx, q.from, q.to);
  });

  app.get('/api/templates', async () => listTemplates(ctx));
  app.get('/api/templates/:id', async (req) => getTemplate(ctx, idParam(req)));
  app.post('/api/templates', async (req, reply) => {
    const t = createTemplate(ctx, parse(TemplateBody, req.body));
    tick();
    return reply.status(201).send(getTemplate(ctx, t.id));
  });
  app.patch('/api/templates/:id', async (req) => {
    const id = idParam(req);
    updateTemplate(ctx, id, parse(UpdateTemplateBody, req.body));
    tick();
    return getTemplate(ctx, id);
  });
  app.delete('/api/templates/:id', async (req, reply) => {
    deleteTemplate(ctx, idParam(req));
    return reply.status(204).send();
  });
  /** "Create now". 409 open_instance (with cardId) while a card from it is open, unless ?force=1. */
  app.post('/api/templates/:id/run', async (req, reply) => {
    const force = (req.query as { force?: string }).force === '1';
    return reply.status(201).send(runTemplateNow(ctx, idParam(req), force));
  });
}

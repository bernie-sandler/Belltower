import {
  ColumnNameBody,
  CreateCardBody,
  DeleteColumnQuery,
  LabelBody,
  MoveCardBody,
  ReorderBody,
  CompleteCardBody,
  BlockedColumnBody,
  UpdateCardBody,
  UpdateLabelBody,
  type AppConfig,
} from '@tt/shared';
import type { FastifyInstance } from 'fastify';
import { accessSync, constants } from 'node:fs';
import type { AppDeps } from '../../app';
import { stmt } from '../../db/connection';
import { listActivity } from '../../services/activity';
import {
  archiveCard,
  completeCard,
  createCard,
  deleteCard,
  getBoard,
  getCard,
  moveCard,
  restoreCard,
  sortColumnByPriority,
  undeleteCard,
  updateCard,
} from '../../services/cards';
import { createColumn, deleteColumn, renameColumn, reorderColumns, setBlockedColumn } from '../../services/columns';
import { createLabel, deleteLabel, reorderLabels, updateLabel } from '../../services/labels';
import { idParam, parse } from '../util';

export function registerBoardRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { ctx, config } = deps;

  // ---- health & config ----
  app.get('/health', { logLevel: 'silent' }, async (_req, reply) => {
    try {
      stmt(ctx.db, 'SELECT 1').get();
      accessSync(config.dataDir, constants.W_OK);
      return { status: 'ok' };
    } catch {
      return reply.status(503).send({ status: 'unavailable' });
    }
  });

  app.get('/api/config', async (): Promise<AppConfig> => ({
    appVersion: config.appVersion,
    timeZone: config.timeZone,
    maxUploadBytes: config.maxUploadBytes,
    passwordManagedByEnv: deps.auth.passwordSource === 'env',
  }));

  app.get('/api/board', async () => getBoard(ctx));

  // ---- columns ----
  app.post('/api/columns', async (req) => createColumn(ctx, parse(ColumnNameBody, req.body).name));
  app.patch('/api/columns/:id', async (req) => renameColumn(ctx, idParam(req), parse(ColumnNameBody, req.body).name));
  app.put('/api/columns/order', async (req) => reorderColumns(ctx, parse(ReorderBody, req.body).ids));
  app.put('/api/board/blocked-column', async (req, reply) => {
    setBlockedColumn(ctx, parse(BlockedColumnBody, req.body).columnId);
    return reply.status(204).send();
  });
  app.post('/api/columns/:id/sort-by-priority', async (req) => ({ orders: sortColumnByPriority(ctx, idParam(req)) }));
  app.delete('/api/columns/:id', async (req, reply) => {
    deleteColumn(ctx, idParam(req), parse(DeleteColumnQuery, req.query).targetColumnId);
    return reply.status(204).send();
  });

  // ---- labels ----
  app.post('/api/labels', async (req) => {
    const body = parse(LabelBody, req.body);
    return createLabel(ctx, body.name, body.color);
  });
  app.patch('/api/labels/:id', async (req) => updateLabel(ctx, idParam(req), parse(UpdateLabelBody, req.body)));
  app.put('/api/labels/order', async (req) => reorderLabels(ctx, parse(ReorderBody, req.body).ids));
  app.delete('/api/labels/:id', async (req, reply) => {
    deleteLabel(ctx, idParam(req));
    return reply.status(204).send();
  });

  // ---- cards ----
  app.post('/api/cards', async (req, reply) => {
    const card = createCard(ctx, parse(CreateCardBody, req.body), { source: 'manual' });
    return reply.status(201).send(card);
  });
  app.get('/api/cards/:id', async (req) => getCard(ctx, idParam(req)));
  app.patch('/api/cards/:id', async (req) => updateCard(ctx, idParam(req), parse(UpdateCardBody, req.body)));
  app.post('/api/cards/:id/move', async (req) => moveCard(ctx, idParam(req), parse(MoveCardBody, req.body)));
  app.post('/api/cards/:id/complete', async (req) => completeCard(ctx, idParam(req), parse(CompleteCardBody, req.body)));
  app.delete('/api/cards/:id', async (req, reply) => {
    deleteCard(ctx, idParam(req));
    return reply.status(204).send();
  });
  app.post('/api/cards/:id/undelete', async (req) => undeleteCard(ctx, idParam(req)));
  app.post('/api/cards/:id/archive', async (req) => archiveCard(ctx, idParam(req)));
  app.post('/api/cards/:id/restore', async (req) => restoreCard(ctx, idParam(req)));
  app.get('/api/cards/:id/activity', async (req) => {
    const id = idParam(req);
    getCard(ctx, id); // 404 for unknown cards
    return listActivity(ctx, id);
  });
}

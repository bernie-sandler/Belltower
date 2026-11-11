import {
  ColumnNameBody,
  CreateCardBody,
  DeleteColumnQuery,
  LabelBody,
  MoveCardBody,
  MoveCardsBody,
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
  moveCards,
  restoreCard,
  sortColumnByPriority,
  undeleteCard,
  updateCard,
} from '../../services/cards';
import { createColumn, deleteColumn, renameColumn, reorderColumns, setBlockedColumn } from '../../services/columns';
import { createLabel, deleteLabel, reorderLabels, updateLabel } from '../../services/labels';
import { getSubmitSettings, teamsEnabled } from '../../services/settings';
import { statusLink } from '../../services/status';
import { idParam, parse } from '../util';

export function registerBoardRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { config } = deps;

  // ---- health & config ----
  app.get('/health', { logLevel: 'silent' }, async (req, reply) => {
    try {
      stmt(req.ctx.db, 'SELECT 1').get();
      accessSync(config.dataDir, constants.W_OK);
      return { status: 'ok' };
    } catch {
      return reply.status(503).send({ status: 'unavailable' });
    }
  });

  app.get('/api/config', async (req): Promise<AppConfig> => ({
    appVersion: config.appVersion,
    timeZone: config.timeZone,
    maxUploadBytes: config.maxUploadBytes,
    // APP_PASSWORD only manages the owner's password.
    passwordManagedByEnv: deps.auth.passwordSource === 'env' && req.user?.isOwner === true,
    // What the app shell shows (the nav, the bell), without loading every setting.
    teams: teamsEnabled(req.ctx),
    submitPageEnabled: getSubmitSettings(req.ctx).enabled === true,
  }));

  app.get('/api/board', async (req) => getBoard(req.ctx));

  // ---- columns ----
  app.post('/api/columns', async (req) => createColumn(req.ctx, parse(ColumnNameBody, req.body).name));
  app.patch('/api/columns/:id', async (req) => renameColumn(req.ctx, idParam(req), parse(ColumnNameBody, req.body).name));
  app.put('/api/columns/order', async (req) => reorderColumns(req.ctx, parse(ReorderBody, req.body).ids));
  app.put('/api/board/blocked-column', async (req, reply) => {
    setBlockedColumn(req.ctx, parse(BlockedColumnBody, req.body).columnId);
    return reply.status(204).send();
  });
  app.post('/api/columns/:id/sort-by-priority', async (req) => ({ orders: sortColumnByPriority(req.ctx, idParam(req)) }));
  app.delete('/api/columns/:id', async (req, reply) => {
    deleteColumn(req.ctx, idParam(req), parse(DeleteColumnQuery, req.query).targetColumnId);
    return reply.status(204).send();
  });

  // ---- labels ----
  app.post('/api/labels', async (req) => {
    const body = parse(LabelBody, req.body);
    return createLabel(req.ctx, body.name, body.color);
  });
  app.patch('/api/labels/:id', async (req) => updateLabel(req.ctx, idParam(req), parse(UpdateLabelBody, req.body)));
  app.put('/api/labels/order', async (req) => reorderLabels(req.ctx, parse(ReorderBody, req.body).ids));
  app.delete('/api/labels/:id', async (req, reply) => {
    deleteLabel(req.ctx, idParam(req));
    return reply.status(204).send();
  });

  // ---- cards ----
  app.post('/api/cards', async (req, reply) => {
    const card = createCard(req.ctx, parse(CreateCardBody, req.body), { source: 'manual' });
    return reply.status(201).send(card);
  });
  app.get('/api/cards/:id', async (req) => getCard(req.ctx, idParam(req)));
  app.patch('/api/cards/:id', async (req) => updateCard(req.ctx, idParam(req), parse(UpdateCardBody, req.body)));
  app.post('/api/cards/:id/move', async (req) => moveCard(req.ctx, idParam(req), parse(MoveCardBody, req.body)));
  app.post('/api/cards/move-many', async (req) => {
    const { cardIds, ...position } = parse(MoveCardsBody, req.body);
    return moveCards(req.ctx, cardIds, position);
  });
  app.post('/api/cards/:id/complete', async (req) => completeCard(req.ctx, idParam(req), parse(CompleteCardBody, req.body)));
  app.delete('/api/cards/:id', async (req, reply) => {
    deleteCard(req.ctx, idParam(req));
    return reply.status(204).send();
  });
  app.post('/api/cards/:id/undelete', async (req) => undeleteCard(req.ctx, idParam(req)));
  app.post('/api/cards/:id/archive', async (req) => archiveCard(req.ctx, idParam(req)));
  app.post('/api/cards/:id/restore', async (req) => restoreCard(req.ctx, idParam(req)));
  app.get('/api/cards/:id/status-link', async (req) => statusLink(req.ctx, idParam(req)));
  app.get('/api/cards/:id/activity', async (req) => {
    const id = idParam(req);
    getCard(req.ctx, id); // 404 for unknown cards
    return listActivity(req.ctx, id);
  });
}

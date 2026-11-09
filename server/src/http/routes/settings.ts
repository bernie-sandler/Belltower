// Settings page: general options, the submit page and its request types, API tokens, and Discord
// notifications. Signed-in only, like the rest of /api.

import {
  ApiTokenBody,
  DiscordSettingsBody,
  ResolutionReasonsBody,
  GeneralSettingsBody,
  ReorderBody,
  RequestTypeBody,
  SubmitSettingsBody,
} from '@tt/shared';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app';
import { AppError } from '../../errors';
import {
  createRequestType,
  deleteRequestType,
  listRequestTypes,
  reorderRequestTypes,
  updateRequestType,
} from '../../services/requestTypes';
import {
  regenerateSubmitKey,
  setResolutionReasons,
  settingsResponse,
  updateDiscordSettings,
  updateGeneralSettings,
  updateSubmitSettings,
} from '../../services/settings';
import { resetStatusLinks } from '../../services/status';
import { createToken, listTokens, revokeToken } from '../../services/tokens';
import { idParam, parse } from '../util';

export function registerSettingsRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { ctx, config } = deps;
  const current = () => settingsResponse(ctx, { modelFromEnv: config.anthropicApiKey ? config.aiModel : null, enabled: deps.ai !== null });

  app.get('/api/settings', async () => current());
  app.put('/api/settings/general', async (req) => {
    updateGeneralSettings(ctx, parse(GeneralSettingsBody, req.body));
    return current();
  });
  app.put('/api/settings/submit', async (req) => {
    updateSubmitSettings(ctx, parse(SubmitSettingsBody, req.body));
    return current();
  });
  app.put('/api/settings/resolutions', async (req) => {
    setResolutionReasons(ctx, parse(ResolutionReasonsBody, req.body).reasons);
    return current();
  });
  app.post('/api/settings/submit/new-link', async () => {
    regenerateSubmitKey(ctx);
    return current();
  });
  app.post('/api/settings/submit/reset-status-links', async () => {
    resetStatusLinks(ctx);
    return current();
  });
  app.put('/api/settings/discord', async (req) => {
    updateDiscordSettings(ctx, parse(DiscordSettingsBody, req.body));
    return current();
  });
  app.post('/api/settings/discord/test', async () => {
    if (!deps.notifier) throw new AppError(503, 'unavailable', 'Notifications aren’t available');
    const result = await deps.notifier.sendTest(ctx);
    return { ...result, settings: current() };
  });

  app.post('/api/settings/discord/digest-now', async () => {
    if (!deps.notifier) throw new AppError(503, 'unavailable', 'Notifications aren’t available');
    const result = await deps.notifier.sendDigest(ctx, ctx.clock.now());
    return { ...result, settings: current() };
  });

  // ---- request types ----
  app.get('/api/request-types', async () => listRequestTypes(ctx));
  app.post('/api/request-types', async (req, reply) => reply.status(201).send(createRequestType(ctx, parse(RequestTypeBody, req.body))));
  app.put('/api/request-types/order', async (req) => reorderRequestTypes(ctx, parse(ReorderBody, req.body).ids));
  app.put('/api/request-types/:id', async (req) => updateRequestType(ctx, idParam(req), parse(RequestTypeBody, req.body)));
  app.delete('/api/request-types/:id', async (req, reply) => {
    deleteRequestType(ctx, idParam(req));
    return reply.status(204).send();
  });

  // ---- API tokens ----
  app.get('/api/tokens', async () => listTokens(ctx));
  app.post('/api/tokens', async (req, reply) => reply.status(201).send(createToken(ctx, parse(ApiTokenBody, req.body))));
  app.delete('/api/tokens/:id', async (req, reply) => {
    revokeToken(ctx, idParam(req));
    return reply.status(204).send();
  });
}

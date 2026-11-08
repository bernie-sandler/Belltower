// Settings page: general options, the submit page and its request types, API tokens, and
// notifications (Discord, ntfy, Gotify, webhook). Signed-in only, like the rest of /api.

import {
  ApiTokenBody,
  DiscordSettingsBody,
  NotifyAlertsBody,
  NotifyChannelBody,
  ResolutionReasonsBody,
  type NotifyChannel,
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
  updateAlertSettings,
  updateChannelSettings,
  updateDiscordSettings,
  updateGeneralSettings,
  updateSubmitSettings,
} from '../../services/settings';
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

  // ---- every channel: alert levels and summary time; then ntfy, Gotify, webhook ----
  app.put('/api/settings/notify', async (req) => {
    updateAlertSettings(ctx, parse(NotifyAlertsBody, req.body));
    return current();
  });
  const saveChannel = (channel: NotifyChannel, body: unknown) => {
    updateChannelSettings(ctx, channel, parse(NotifyChannelBody, body));
    return current();
  };
  const notifier = () => {
    if (!deps.notifier) throw new AppError(503, 'unavailable', 'Notifications aren’t available');
    return deps.notifier;
  };
  const testChannel = async (channel: NotifyChannel) => ({ ...(await notifier().sendTest(ctx, channel)), settings: current() });
  const digestNow = async (channel: NotifyChannel) => ({ ...(await notifier().sendDigest(ctx, ctx.clock.now(), channel)), settings: current() });
  // Each route spelled out, so the demo's route list (web/src/demo/routes.test.ts) sees it.
  app.put('/api/settings/notify/ntfy', async (req) => saveChannel('ntfy', req.body));
  app.put('/api/settings/notify/gotify', async (req) => saveChannel('gotify', req.body));
  app.put('/api/settings/notify/webhook', async (req) => saveChannel('webhook', req.body));
  app.post('/api/settings/notify/ntfy/test', async () => testChannel('ntfy'));
  app.post('/api/settings/notify/gotify/test', async () => testChannel('gotify'));
  app.post('/api/settings/notify/webhook/test', async () => testChannel('webhook'));
  app.post('/api/settings/notify/ntfy/digest-now', async () => digestNow('ntfy'));
  app.post('/api/settings/notify/gotify/digest-now', async () => digestNow('gotify'));
  app.post('/api/settings/notify/webhook/digest-now', async () => digestNow('webhook'));

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

// Settings page: general options, the submit page and its request types, API tokens, and
// notifications (Discord, ntfy, Gotify, webhook). Everyone signed in can read the settings (they're
// redacted); changing them is for admins. API tokens: your own, or everyone's for admins.

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
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppDeps } from '../../app';
import { AppError } from '../../errors';
import type { Ctx } from '../../services/context';
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
import { resetStatusLinks } from '../../services/status';
import { createToken, listTokens, revokeToken } from '../../services/tokens';
import { ADMIN } from '../guard';
import { idParam, parse } from '../util';

export function registerSettingsRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { config } = deps;
  const current = (ctx: Ctx) => settingsResponse(ctx, { modelFromEnv: config.anthropicApiKey ? config.aiModel : null, enabled: deps.ai !== null });

  app.get('/api/settings', async (req) => current(req.ctx));
  app.put('/api/settings/general', ADMIN, async (req) => {
    updateGeneralSettings(req.ctx, parse(GeneralSettingsBody, req.body));
    return current(req.ctx);
  });
  app.put('/api/settings/submit', ADMIN, async (req) => {
    updateSubmitSettings(req.ctx, parse(SubmitSettingsBody, req.body));
    return current(req.ctx);
  });
  app.put('/api/settings/resolutions', ADMIN, async (req) => {
    setResolutionReasons(req.ctx, parse(ResolutionReasonsBody, req.body).reasons);
    return current(req.ctx);
  });
  app.post('/api/settings/submit/new-link', ADMIN, async (req) => {
    regenerateSubmitKey(req.ctx);
    return current(req.ctx);
  });
  app.post('/api/settings/submit/reset-status-links', ADMIN, async (req) => {
    resetStatusLinks(req.ctx);
    return current(req.ctx);
  });
  app.put('/api/settings/discord', ADMIN, async (req) => {
    updateDiscordSettings(req.ctx, parse(DiscordSettingsBody, req.body));
    return current(req.ctx);
  });

  const notifier = () => {
    if (!deps.notifier) throw new AppError(503, 'unavailable', 'Notifications aren’t available');
    return deps.notifier;
  };
  app.post('/api/settings/discord/test', ADMIN, async (req) => {
    const result = await notifier().sendTest(req.ctx);
    return { ...result, settings: current(req.ctx) };
  });
  app.post('/api/settings/discord/digest-now', ADMIN, async (req) => {
    const result = await notifier().sendDigest(req.ctx, req.ctx.clock.now());
    return { ...result, settings: current(req.ctx) };
  });

  // ---- every channel: alert levels and summary time; then ntfy, Gotify, webhook ----
  app.put('/api/settings/notify', ADMIN, async (req) => {
    updateAlertSettings(req.ctx, parse(NotifyAlertsBody, req.body));
    return current(req.ctx);
  });
  const saveChannel = (req: FastifyRequest, channel: NotifyChannel) => {
    updateChannelSettings(req.ctx, channel, parse(NotifyChannelBody, req.body));
    return current(req.ctx);
  };
  const testChannel = async (req: FastifyRequest, channel: NotifyChannel) => ({
    ...(await notifier().sendTest(req.ctx, channel)),
    settings: current(req.ctx),
  });
  const digestNow = async (req: FastifyRequest, channel: NotifyChannel) => ({
    ...(await notifier().sendDigest(req.ctx, req.ctx.clock.now(), channel)),
    settings: current(req.ctx),
  });
  // Each route spelled out, so the demo's route list (web/src/demo/routes.test.ts) sees it.
  app.put('/api/settings/notify/ntfy', ADMIN, async (req) => saveChannel(req, 'ntfy'));
  app.put('/api/settings/notify/gotify', ADMIN, async (req) => saveChannel(req, 'gotify'));
  app.put('/api/settings/notify/webhook', ADMIN, async (req) => saveChannel(req, 'webhook'));
  app.post('/api/settings/notify/ntfy/test', ADMIN, async (req) => testChannel(req, 'ntfy'));
  app.post('/api/settings/notify/gotify/test', ADMIN, async (req) => testChannel(req, 'gotify'));
  app.post('/api/settings/notify/webhook/test', ADMIN, async (req) => testChannel(req, 'webhook'));
  app.post('/api/settings/notify/ntfy/digest-now', ADMIN, async (req) => digestNow(req, 'ntfy'));
  app.post('/api/settings/notify/gotify/digest-now', ADMIN, async (req) => digestNow(req, 'gotify'));
  app.post('/api/settings/notify/webhook/digest-now', ADMIN, async (req) => digestNow(req, 'webhook'));

  // ---- request types (the submit page's forms) ----
  app.get('/api/request-types', async (req) => listRequestTypes(req.ctx));
  app.post('/api/request-types', ADMIN, async (req, reply) => reply.status(201).send(createRequestType(req.ctx, parse(RequestTypeBody, req.body))));
  app.put('/api/request-types/order', ADMIN, async (req) => reorderRequestTypes(req.ctx, parse(ReorderBody, req.body).ids));
  app.put('/api/request-types/:id', ADMIN, async (req) => updateRequestType(req.ctx, idParam(req), parse(RequestTypeBody, req.body)));
  app.delete('/api/request-types/:id', ADMIN, async (req, reply) => {
    deleteRequestType(req.ctx, idParam(req));
    return reply.status(204).send();
  });

  // ---- API tokens: admins see and revoke everyone's, members only their own ----
  const ownerScope = (req: FastifyRequest) => (req.user!.role === 'admin' ? {} : { ownerId: req.user!.id });
  app.get('/api/tokens', async (req) => listTokens(req.ctx, ownerScope(req)));
  app.post('/api/tokens', async (req, reply) => reply.status(201).send(createToken(req.ctx, parse(ApiTokenBody, req.body))));
  app.delete('/api/tokens/:id', async (req, reply) => {
    revokeToken(req.ctx, idParam(req), ownerScope(req));
    return reply.status(204).send();
  });
}

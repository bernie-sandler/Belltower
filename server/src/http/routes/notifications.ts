// Personal notifications (1.5): your bell, watching cards, and your own channels under Account →
// Notifications. Everything here is about the signed-in person; nobody reads or changes anyone
// else's notifications.

import {
  MarkNotificationsReadBody,
  NotificationsQuery,
  PersonalNotifyBody,
  type NotificationsResponse,
  type PersonalNotifySettings,
  type PersonalTestResult,
} from '@tt/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppDeps } from '../../app';
import { AppError } from '../../errors';
import { WindowLimiter } from '../../lib/windowLimiter';
import { getCardRow } from '../../services/cards';
import {
  listNotifications,
  markNotificationsRead,
  personalNotifySettings,
  unwatchCard,
  updatePersonalNotify,
  watchCard,
} from '../../services/notifications';
import { PASSIVE } from '../guard';
import { idParam, parse } from '../util';

/** "Send me a test" posts in the install's shared Discord channel, so it's limited per person. */
export const PERSONAL_TEST_LIMIT = { max: 5, windowMs: 10 * 60 * 1000 };

export function registerNotificationRoutes(app: FastifyInstance, deps: AppDeps): void {
  const me = (req: FastifyRequest): number => req.user!.id;
  const tests = new WindowLimiter(deps.baseCtx.clock, PERSONAL_TEST_LIMIT.max, PERSONAL_TEST_LIMIT.windowMs);

  // ---- the bell ----
  // Polled every 30 seconds, also in background tabs: it mustn't count as you using the app.
  app.get('/api/notifications', PASSIVE, async (req): Promise<NotificationsResponse> =>
    listNotifications(req.ctx, me(req), parse(NotificationsQuery, req.query)),
  );
  app.post('/api/notifications/read', async (req): Promise<{ unread: number }> => ({
    unread: markNotificationsRead(req.ctx, me(req), parse(MarkNotificationsReadBody, req.body)),
  }));

  // ---- watching ----
  app.put('/api/cards/:id/watch', async (req): Promise<{ watching: boolean }> => {
    const id = idParam(req);
    getCardRow(req.ctx, id); // 404 for unknown cards
    watchCard(req.ctx, id, me(req));
    return { watching: true };
  });
  app.delete('/api/cards/:id/watch', async (req): Promise<{ watching: boolean }> => {
    const id = idParam(req);
    getCardRow(req.ctx, id);
    unwatchCard(req.ctx, id, me(req));
    return { watching: false };
  });

  // ---- your channels and what goes where ----
  app.get('/api/me/notifications', async (req): Promise<PersonalNotifySettings> => personalNotifySettings(req.ctx, me(req)));
  app.put('/api/me/notifications', async (req): Promise<PersonalNotifySettings> =>
    updatePersonalNotify(req.ctx, me(req), parse(PersonalNotifyBody, req.body)),
  );
  app.post('/api/me/notifications/test', async (req): Promise<PersonalTestResult> => {
    if (!deps.notifier) throw new AppError(503, 'unavailable', 'Notifications aren’t available');
    const settings = personalNotifySettings(req.ctx, me(req));
    if (!settings.discordUserId && !settings.ntfyTopic) {
      throw new AppError(400, 'nothing_to_test', 'Fill in your Discord user ID or an ntfy topic, and save, first');
    }
    const r = tests.take(String(me(req)));
    if (!r.ok) throw new AppError(429, 'rate_limited', 'That’s enough tests for now; try again in a few minutes', { retryAfterSec: r.retryAfterSec });
    return deps.notifier.sendPersonalTest(req.ctx, me(req));
  });
}

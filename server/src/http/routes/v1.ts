// Automation API (/api/v1/*): bearer tokens only, no cookies or CSRF header. The guard checks the
// token and puts its identity on the request.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppDeps } from '../../app';
import { AppError } from '../../errors';
import { WindowLimiter } from '../../lib/windowLimiter';
import { intakeCard, intakeUptimeKuma } from '../../services/intake';
import type { TokenIdentity } from '../../services/tokens';

declare module 'fastify' {
  interface FastifyRequest {
    apiToken: TokenIdentity | null;
  }
}

/** Per token: 120 calls a minute (a monitor flapping shouldn't be able to flood the board). */
export const V1_LIMIT = { max: 120, windowMs: 60_000 };

export function registerV1Routes(app: FastifyInstance, deps: AppDeps): void {
  const { ctx } = deps;
  const limiter = new WindowLimiter(ctx.clock, V1_LIMIT.max, V1_LIMIT.windowMs);

  const token = (req: FastifyRequest): TokenIdentity => {
    const t = req.apiToken;
    if (!t) throw new AppError(401, 'unauthenticated', 'Send an API token: Authorization: Bearer tt_…');
    const r = limiter.take(String(t.id));
    if (!r.ok) throw new AppError(429, 'rate_limited', 'Too many requests for this token', { retryAfterSec: r.retryAfterSec });
    return t;
  };

  app.post('/api/v1/cards', async (req, reply) => {
    const result = intakeCard(ctx, token(req), req.body);
    return reply.status(result.status === 'created' ? 201 : 200).send(result);
  });

  /** Uptime Kuma "Webhook" notification. Query: labels, priority, severity, column (all optional). */
  app.post('/api/v1/hooks/uptime-kuma', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const defaults = Object.fromEntries(
      ['labels', 'priority', 'severity', 'column']
        .filter((k) => typeof q[k] === 'string' && (q[k] as string).trim())
        .map((k) => [k, (q[k] as string).trim().slice(0, 200)]),
    );
    const result = intakeUptimeKuma(ctx, token(req), (req.body ?? {}) as Parameters<typeof intakeUptimeKuma>[2], defaults);
    return reply.status(result.status === 'created' ? 201 : 200).send(result);
  });
}

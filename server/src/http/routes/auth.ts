import { ChangePasswordBody, LoginBody, SESSION_COOKIE, SetupBody, type AuthStatus } from '@tt/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AppDeps } from '../../app';
import { hashPassword, needsRehash, setupCodeMatches, verifyPassword } from '../../auth/password';
import { createSession, deleteAllSessions, deleteSessionByToken } from '../../auth/sessions';
import { getSetting, setSetting, stmt } from '../../db/connection';
import { AppError, conflict } from '../../errors';
import { clearSessionCookie, resolveSession, setSessionCookie } from '../guard';
import { parse } from '../util';

export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { ctx, limiter } = deps;
  const policy = { rememberDays: deps.config.sessionDays };

  /** Applies the failed-login limiter before any expensive hashing happens. */
  async function gate(req: FastifyRequest): Promise<void> {
    const decision = limiter.check(req.ip);
    if (!decision.allowed) {
      throw new AppError(429, 'rate_limited', `Too many failed attempts. Try again in ${decision.retryAfterSec}s.`, {
        retryAfterSec: decision.retryAfterSec,
      });
    }
    if (decision.delayMs) await sleep(decision.delayMs);
  }

  function failed(req: FastifyRequest, what: string): void {
    limiter.recordFailure(req.ip);
    req.log.warn({ ip: req.ip }, `Failed ${what}`);
  }

  /** Compare-and-swap on the stored hash so concurrent changes can't silently undo each other. */
  function replaceHashIfUnchanged(expected: string, next: string): boolean {
    return (
      stmt(ctx.db, `UPDATE settings SET value = ? WHERE key = 'password_hash' AND value = ?`).run(next, expected)
        .changes === 1
    );
  }

  function startSession(req: FastifyRequest, reply: Parameters<typeof setSessionCookie>[1], remember: boolean) {
    const { token, expiresAt, session } = createSession(ctx, policy, {
      remember,
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
    setSessionCookie(req, reply, deps, token, remember, expiresAt);
    return session;
  }

  app.get('/api/auth/status', async (req, reply): Promise<AuthStatus> => {
    const hasPassword = getSetting(ctx.db, 'password_hash') !== null;
    return {
      authenticated: hasPassword && resolveSession(req, reply, deps) !== null,
      setupRequired: !hasPassword,
      passwordManagedByEnv: deps.auth.passwordSource === 'env',
    };
  });

  app.post('/api/auth/setup', async (req, reply) => {
    if (getSetting(ctx.db, 'password_hash') !== null || !deps.auth.setupCode) {
      throw new AppError(404, 'setup_not_available', 'A password has already been set');
    }
    await gate(req);
    const body = parse(SetupBody, req.body);
    if (!setupCodeMatches(body.setupCode, deps.auth.setupCode)) {
      failed(req, 'setup (wrong setup code)');
      throw new AppError(403, 'invalid_setup_code', 'That setup code is not correct. Check the container log.');
    }
    const hash = await hashPassword(body.password);
    // ON CONFLICT DO NOTHING: if two setup requests race, only the first one wins.
    const result = stmt(ctx.db, `INSERT INTO settings (key, value) VALUES ('password_hash', ?) ON CONFLICT(key) DO NOTHING`).run(hash);
    if (result.changes === 0) throw new AppError(404, 'setup_not_available', 'A password has already been set');
    setSetting(ctx.db, 'password_source', 'ui');
    deps.auth.setupCode = null;
    deps.auth.passwordSource = 'ui';
    limiter.recordSuccess(req.ip);
    startSession(req, reply, true);
    req.log.info('First-run setup complete; password set');
    return reply.status(204).send();
  });

  app.post('/api/auth/login', async (req, reply) => {
    if (getSetting(ctx.db, 'password_hash') === null) throw conflict('setup_required', 'No password has been set yet');
    await gate(req);
    const body = parse(LoginBody, req.body);
    // Read the hash only after waiting, and re-check it after verifying: if the password was changed
    // meanwhile, a login with the old one must not get a session that outlives the revocation.
    const stored = getSetting(ctx.db, 'password_hash')!;
    const ok = await verifyPassword(body.password, stored);
    if (!ok || getSetting(ctx.db, 'password_hash') !== stored) {
      failed(req, 'login');
      throw new AppError(401, 'invalid_password', 'Incorrect password');
    }
    limiter.recordSuccess(req.ip);
    startSession(req, reply, body.remember);
    if (needsRehash(stored)) {
      const upgraded = await hashPassword(body.password);
      replaceHashIfUnchanged(stored, upgraded);
    }
    return reply.status(204).send();
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) deleteSessionByToken(ctx, token);
    clearSessionCookie(req, reply, deps);
    return reply.status(204).send();
  });

  app.post('/api/auth/password', async (req, reply) => {
    if (deps.auth.passwordSource === 'env') {
      throw conflict('managed_by_env', 'The password is set by APP_PASSWORD; change it there and restart');
    }
    await gate(req);
    const body = parse(ChangePasswordBody, req.body);
    const stored = getSetting(ctx.db, 'password_hash');
    if (!stored || !(await verifyPassword(body.currentPassword, stored))) {
      failed(req, 'password change');
      throw new AppError(401, 'invalid_password', 'Current password is incorrect');
    }
    const next = await hashPassword(body.newPassword);
    if (!replaceHashIfUnchanged(stored, next)) {
      throw conflict('password_changed', 'The password was changed at the same time; log in again and retry');
    }
    const revoked = deleteAllSessions(ctx, req.session!.id);
    req.log.info(`Password changed; signed out ${revoked} other session(s)`);
    return reply.status(204).send();
  });
}

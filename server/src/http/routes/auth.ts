import { ChangePasswordBody, LoginBody, SESSION_COOKIE, SetupBody, type AuthStatus } from '@tt/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AppDeps } from '../../app';
import { hashPassword, needsRehash, setupCodeMatches, verifyDummy, verifyPassword } from '../../auth/password';
import { createSession, deleteSessionByToken, deleteUserSessions } from '../../auth/sessions';
import { setSetting } from '../../db/connection';
import { AppError, conflict } from '../../errors';
import { createOwner, findUser, getUser, hasUsers, loginCandidate, replacePasswordHash } from '../../services/users';
import { clearSessionCookie, resolveSession, setSessionCookie } from '../guard';
import { parse } from '../util';

export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { limiter } = deps;
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

  function startSession(req: FastifyRequest, reply: Parameters<typeof setSessionCookie>[1], userId: number, remember: boolean) {
    const { token, expiresAt, session } = createSession(req.ctx, policy, {
      userId,
      remember,
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
    setSessionCookie(req, reply, deps, token, remember, expiresAt);
    return session;
  }

  app.get('/api/auth/status', async (req, reply): Promise<AuthStatus> => {
    const setUp = hasUsers(req.ctx);
    return {
      authenticated: setUp && resolveSession(req, reply, deps) !== null,
      setupRequired: !setUp,
      passwordManagedByEnv: deps.auth.passwordSource === 'env',
    };
  });

  app.post('/api/auth/setup', async (req, reply) => {
    if (hasUsers(req.ctx) || !deps.auth.setupCode) {
      throw new AppError(404, 'setup_not_available', 'This install has already been set up');
    }
    await gate(req);
    const body = parse(SetupBody, req.body);
    if (!setupCodeMatches(body.setupCode, deps.auth.setupCode)) {
      failed(req, 'setup (wrong setup code)');
      throw new AppError(403, 'invalid_setup_code', 'That setup code is not correct. Check the container log.');
    }
    const hash = await hashPassword(body.password);
    // Only when nobody exists yet: if two setup requests race, only the first one wins.
    const ownerId = createOwner(req.ctx, { username: body.username, displayName: body.displayName ?? body.username, passwordHash: hash });
    if (ownerId === null) throw new AppError(404, 'setup_not_available', 'This install has already been set up');
    setSetting(req.ctx.db, 'password_source', 'ui');
    deps.auth.setupCode = null;
    deps.auth.passwordSource = 'ui';
    limiter.recordSuccess(req.ip);
    startSession(req, reply, ownerId, true);
    req.log.info(`First-run setup complete; created the owner account "${body.username}"`);
    return reply.status(204).send();
  });

  app.post('/api/auth/login', async (req, reply) => {
    if (!hasUsers(req.ctx)) throw conflict('setup_required', 'This install hasn’t been set up yet');
    await gate(req);
    const body = parse(LoginBody, req.body);
    // Read the account only after waiting, and re-check it after verifying: if the password was
    // changed (or the account deactivated) meanwhile, the old password must not get a session.
    const user = loginCandidate(req.ctx, body.username);
    const stored = user && user.disabled_at === null ? user.password_hash : null;
    // Unknown, deactivated and SSO-only accounts take as long to fail as a wrong password.
    const ok = stored !== null ? await verifyPassword(body.password, stored) : await verifyDummy(body.password);
    const now = user ? findUser(req.ctx, user.id) : undefined;
    if (!ok || !now || now.password_hash !== stored || now.disabled_at !== null) {
      failed(req, 'login');
      throw new AppError(401, 'invalid_password', 'Incorrect username or password');
    }
    limiter.recordSuccess(req.ip);
    startSession(req, reply, now.id, body.remember);
    if (needsRehash(stored!)) {
      const upgraded = await hashPassword(body.password);
      replacePasswordHash(req.ctx, now.id, stored!, upgraded);
    }
    return reply.status(204).send();
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) deleteSessionByToken(req.ctx, token);
    clearSessionCookie(req, reply, deps);
    return reply.status(204).send();
  });

  /** Your own password. Signs you out on your other devices; nobody else is affected. */
  app.post('/api/auth/password', async (req, reply) => {
    const me = getUser(req.ctx, req.user!.id);
    if (me.is_owner === 1 && deps.auth.passwordSource === 'env') {
      throw conflict('managed_by_env', 'The password is set by APP_PASSWORD; change it there and restart');
    }
    await gate(req);
    const body = parse(ChangePasswordBody, req.body);
    const stored = getUser(req.ctx, me.id).password_hash;
    if (!stored || !(await verifyPassword(body.currentPassword, stored))) {
      failed(req, 'password change');
      throw new AppError(401, 'invalid_password', 'Current password is incorrect');
    }
    const next = await hashPassword(body.newPassword);
    if (!replacePasswordHash(req.ctx, me.id, stored, next)) {
      throw conflict('password_changed', 'The password was changed at the same time; log in again and retry');
    }
    const revoked = deleteUserSessions(req.ctx, me.id, req.session!.id);
    req.log.info(`Password of "${me.username}" changed; signed out ${revoked} other session(s)`);
    return reply.status(204).send();
  });
}

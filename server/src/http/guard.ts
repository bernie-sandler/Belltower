import { CSRF_HEADER, CSRF_VALUE, SESSION_COOKIE } from '@tt/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { lookupSession, type SessionRow } from '../auth/sessions';
import { AppError } from '../errors';
import type { AppDeps } from '../app';

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionRow | null;
  }
}

/** API routes reachable without a session. */
const PUBLIC_ROUTES = new Set([
  'GET /api/auth/status',
  'POST /api/auth/login',
  'POST /api/auth/setup',
  'POST /api/auth/logout',
]);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isSecureRequest(req: FastifyRequest, deps: AppDeps): boolean {
  if (deps.config.cookieSecure === 'true') return true;
  if (deps.config.cookieSecure === 'false') return false;
  return req.protocol === 'https';
}

export function setSessionCookie(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: AppDeps,
  token: string,
  remember: boolean,
  expiresAt: Date,
): void {
  const secure = isSecureRequest(req, deps);
  if (secure && req.protocol !== 'https') {
    req.log.warn('COOKIE_SECURE=true but this request arrived over plain HTTP; the browser will drop the cookie');
  }
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    // Without "remember", a browser-session cookie; the server also expires it after 12h idle.
    ...(remember ? { expires: expiresAt } : {}),
  });
}

export function clearSessionCookie(req: FastifyRequest, reply: FastifyReply, deps: AppDeps): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure: isSecureRequest(req, deps) });
}

/** Resolves the session for a request without enforcing it (used by /api/auth/status too). */
export function resolveSession(req: FastifyRequest, reply: FastifyReply, deps: AppDeps): SessionRow | null {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const found = lookupSession(deps.ctx, { rememberDays: deps.config.sessionDays }, token);
  if (!found) {
    clearSessionCookie(req, reply, deps);
    return null;
  }
  if (found.refreshed && found.session.remember) {
    setSessionCookie(req, reply, deps, token, true, found.expiresAt);
  }
  return found.session;
}

/**
 * Whether a request targets the API. Decided by the route that actually matched, never by the raw
 * URL alone: the router percent-decodes paths, so `/%61pi/board` reaches the `/api/board` handler.
 * Unmatched requests fall back to the decoded path so API 404s still require auth.
 */
export function isApiRequest(req: FastifyRequest): boolean {
  const route = req.routeOptions.url;
  if (route) return route === '/api' || route.startsWith('/api/');
  let path = req.url.split('?', 1)[0]!;
  try {
    path = decodeURIComponent(path);
  } catch {
    // Malformed escapes: judge the raw path.
  }
  return path === '/api' || path.startsWith('/api/');
}

/**
 * CSRF + authentication. Every state-changing request (there are none outside /api) must carry the
 * custom X-Requested-With header (a cross-site form or fetch can't add it without a CORS preflight we
 * never answer) and, when the browser sends Origin, the Origin host must match the Host we were
 * reached as. Every API route except the public auth endpoints then needs a valid session.
 */
export function installGuard(app: FastifyInstance, deps: AppDeps): void {
  app.decorateRequest('session', null);

  app.addHook('onRequest', async (req, reply) => {
    if (!SAFE_METHODS.has(req.method)) {
      if (req.headers[CSRF_HEADER] !== CSRF_VALUE) {
        throw new AppError(403, 'csrf', `Missing ${CSRF_HEADER} header`);
      }
      const origin = req.headers.origin;
      if (origin) {
        let originHost: string | null = null;
        try {
          originHost = new URL(origin).host;
        } catch {
          originHost = null;
        }
        if (!originHost || originHost !== req.host) {
          throw new AppError(403, 'csrf', 'Cross-origin request rejected');
        }
      }
    }

    if (!isApiRequest(req)) return;
    if (req.routeOptions.url && PUBLIC_ROUTES.has(`${req.method} ${req.routeOptions.url}`)) return;

    const session = resolveSession(req, reply, deps);
    if (!session) throw new AppError(401, 'unauthenticated', 'Please log in');
    req.session = session;
  });
}

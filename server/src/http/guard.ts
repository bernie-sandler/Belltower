import { CSRF_HEADER, CSRF_VALUE, PASSIVE_HEADER, SESSION_COOKIE, type Actor } from '@tt/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from 'fastify';
import { lookupSession, type SessionUser, type SessionWithUser } from '../auth/sessions';
import { withActor, type Ctx } from '../services/context';
import { scopeFor } from '../services/scope';
import { authenticateToken } from '../services/tokens';
import { adminOnly } from '../services/users';
import { AppError } from '../errors';
import type { AppDeps } from '../app';

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionWithUser | null;
    /** The signed-in person; null on public routes and /api/v1. */
    user: SessionUser | null;
    /** What a route hands to services: the app's context, acting as whoever sent the request. */
    ctx: Ctx;
  }
  interface FastifyContextConfig {
    /** Only admins may call this route; members get 403 forbidden. */
    admin?: boolean;
    /**
     * Polled by the app on its own (the bell): checks the session without sliding its expiry, so a
     * tab left open doesn't keep an idle session alive past its 12-hour timeout.
     */
    passive?: boolean;
  }
}

/** Route options for an admin-only route: `app.put('/api/…', ADMIN, handler)`. */
export const ADMIN: RouteShorthandOptions = { config: { admin: true } };
/** Route options for a route the app polls by itself (see FastifyContextConfig.passive). */
export const PASSIVE: RouteShorthandOptions = { config: { passive: true } };

const PUBLIC: Actor = { kind: 'public' };

export interface RouteInfo {
  method: string;
  url: string;
  admin: boolean;
}

const routeTables = new WeakMap<FastifyInstance, RouteInfo[]>();

/** Every route registered on the app, with its admin flag (for the role tests). */
export function registeredRoutes(app: FastifyInstance): RouteInfo[] {
  return routeTables.get(app) ?? [];
}

/** API routes reachable without a session. */
const PUBLIC_ROUTES = new Set([
  'GET /api/auth/status',
  'POST /api/auth/login',
  'POST /api/auth/setup',
  'POST /api/auth/logout',
  // Single sign-on: the flow cookie and the state the provider returns are checked by the route.
  'GET /api/auth/oidc/start',
  'GET /api/auth/oidc/callback',
  // The submit page: its secret key is checked by the route (wrong key → 404).
  'GET /api/public/submit/:key',
  'POST /api/public/submit/:key',
  // Status links: the signature in the address is checked by the route (wrong → 404).
  'GET /api/public/status/:id/:sig',
]);

/**
 * Automation API: bearer tokens only (no cookies, no CSRF header, which tools like Uptime Kuma can't send).
 * Unknown /api/v1 paths too, so a tool gets a token error or a JSON 404 rather than a cookie or CSRF error.
 * Only paths that matched no route are judged by the raw URL: a matched route always decides by its own pattern.
 */
const isV1Route = (req: FastifyRequest) => {
  const route = req.routeOptions.url;
  return route === undefined ? req.url.startsWith('/api/v1/') : route.startsWith('/api/v1/');
};

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
export function resolveSession(req: FastifyRequest, reply: FastifyReply, deps: AppDeps): SessionWithUser | null {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  // A GET marked passive by the app (its live refresh) is trusted as is: it can't change anything,
  // and the header can only make a session end sooner.
  const passive = req.routeOptions.config?.passive === true || (req.method === 'GET' && req.headers[PASSIVE_HEADER] === '1');
  const touch = !passive;
  const found = lookupSession(deps.baseCtx, { rememberDays: deps.config.sessionDays }, token, { touch });
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
 * reached as. Every API route except the public auth endpoints and the submit page then needs a valid
 * session, and routes marked ADMIN need an admin. /api/v1/* is different: an API token in the
 * Authorization header, nothing else. Every request gets `req.ctx`, acting as the person, the token
 * or the public.
 */
export function installGuard(app: FastifyInstance, deps: AppDeps): void {
  app.decorateRequest('session', null);
  app.decorateRequest('user', null);
  app.decorateRequest('apiToken', null);
  app.decorateRequest('ctx', null as unknown as Ctx);

  const table: RouteInfo[] = [];
  routeTables.set(app, table);
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      table.push({ method, url: route.url, admin: (route.config as { admin?: boolean } | undefined)?.admin === true });
    }
  });

  app.addHook('onRequest', async (req, reply) => {
    req.ctx = withActor(deps.baseCtx, PUBLIC);
    if (isV1Route(req)) {
      const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
      req.apiToken = m ? authenticateToken(req.ctx, m[1]!) : null;
      if (!req.apiToken) throw new AppError(401, 'unauthenticated', 'Send a valid API token: Authorization: Bearer tt_…');
      // A token sees what its owner sees: a tag-restricted member's token is restricted too.
      const owner = req.apiToken.userId;
      req.ctx = withActor(deps.baseCtx, { kind: 'token', tokenId: req.apiToken.id, userId: owner }, scopeFor(deps.baseCtx, owner));
      // Read-only tokens only get routes that opt in with config.readScope (the summary), so a route
      // added later is closed to them unless it says otherwise. Unknown paths fall through to the 404.
      if (req.apiToken.scope === 'read' && req.routeOptions.url !== undefined && req.routeOptions.config.readScope !== true) {
        throw new AppError(403, 'forbidden', 'This token is read-only. Create a full token to open tickets.');
      }
      return;
    }

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
    req.user = session.user;
    req.ctx = withActor(deps.baseCtx, { kind: 'user', userId: session.user.id }, scopeFor(deps.baseCtx, session.user.id));
    if (req.routeOptions.config.admin === true && session.user.role !== 'admin') throw adminOnly();
  });
}

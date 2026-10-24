import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { sep } from 'node:path';
import type { AuthState } from './auth/bootstrap';
import type { LoginRateLimiter } from './auth/rateLimit';
import type { Config } from './config';
import { AppError } from './errors';
import { installGuard, isApiRequest } from './http/guard';
import { registerAuthRoutes } from './http/routes/auth';
import { registerBoardRoutes } from './http/routes/board';
import { registerCardPartRoutes } from './http/routes/cardParts';
import { registerPhase3Routes } from './http/routes/phase3';
import { registerPhase4Routes } from './http/routes/phase4';
import type { Ctx } from './services/context';

export interface AppDeps {
  ctx: Ctx;
  config: Config;
  /** Mutable: setup completes / password source changes at runtime. */
  auth: AuthState;
  limiter: LoginRateLimiter;
}

// Explicit CSP rather than helmet defaults: those add upgrade-insecure-requests and HSTS, which
// break plain-HTTP access over the LAN and Tailscale.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export async function buildApp(deps: AppDeps, logger: FastifyBaseLogger): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    loggerInstance: logger,
    // Our own onResponse hook logs what matters; Fastify's per-request lines would flood the log.
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: config.trustProxy || false,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: config.maxUploadBytes, files: 10, fields: 10, parts: 20 },
  });

  // Fastify rejects an empty body sent with Content-Type: application/json, which fetch wrappers
  // commonly set on bodyless DELETE/POST requests. Treat such requests as having no body.
  app.addHook('onRequest', async (req) => {
    const len = req.headers['content-length'];
    if ((len === undefined || len === '0') && req.headers['transfer-encoding'] === undefined) {
      delete req.headers['content-type'];
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    if (!reply.hasHeader('Content-Security-Policy')) reply.header('Content-Security-Policy', CSP);
    if (isApiRequest(req) && !reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // Log mutations and server errors only; GET polling and the healthcheck would flood the log.
  app.addHook('onResponse', async (req, reply) => {
    const status = reply.statusCode;
    if (status >= 500) req.log.error({ method: req.method, url: req.url, status }, 'request failed');
    else if (req.method !== 'GET' && isApiRequest(req)) {
      req.log.info({ status, ms: Math.round(reply.elapsedTime) }, `${req.method} ${req.url.split('?', 1)[0]}`);
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      if (err.status === 429 && typeof err.extra.retryAfterSec === 'number') {
        reply.header('Retry-After', String(err.extra.retryAfterSec));
      }
      return reply.status(err.status).send({ error: err.code, message: err.message, ...err.extra });
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    // A DB CHECK/NOT NULL constraint means input slipped past validation (e.g. a NUL character).
    if (typeof e.code === 'string' && /^SQLITE_CONSTRAINT_(CHECK|NOTNULL)$/.test(e.code)) {
      return reply.status(400).send({ error: 'validation', message: 'Invalid value' });
    }
    if (e.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || e.statusCode === 413) {
      return reply.status(413).send({ error: 'too_large', message: 'Request is too large' });
    }
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: 'bad_request', message: e.message ?? 'Bad request' });
    }
    req.log.error(err);
    return reply.status(500).send({ error: 'internal', message: 'Internal server error' });
  });

  installGuard(app, deps);
  registerAuthRoutes(app, deps);
  registerBoardRoutes(app, deps);
  registerCardPartRoutes(app, deps);
  registerPhase3Routes(app, deps);
  registerPhase4Routes(app, deps);

  if (config.webDistDir) {
    await app.register(fastifyStatic, {
      root: config.webDistDir,
      prefix: '/',
      index: 'index.html',
      wildcard: true,
      setHeaders(reply, filePath) {
        // Vite's hashed bundles never change; index.html must always be revalidated.
        reply.header(
          'Cache-Control',
          filePath.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });
  }

  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?', 1)[0]!;
    if (req.method === 'GET' && !isApiRequest(req) && !path.startsWith('/assets/') && config.webDistDir) {
      // Client-side routes (/cards/12 etc.) all load the SPA.
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    }
    return reply.status(404).send({ error: 'not_found', message: 'Not found' });
  });

  return app;
}

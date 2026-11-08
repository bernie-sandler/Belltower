// The public submit page's API. No session: the secret key in the address is the access check
// (wrong key or page off → 404). Still needs the X-Requested-With header and a same-origin
// Origin (the guard checks both), and is rate limited per address and overall. Status links
// (services/status.ts) are checked the same way: a signature in the address, 404 otherwise.

import { LIMITS, SubmitBody } from '@tt/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { mkdirSync, rmSync } from 'node:fs';
import type { AppDeps } from '../../app';
import { clientKey } from '../../auth/rateLimit';
import { AppError, badRequest } from '../../errors';
import { WindowLimiter } from '../../lib/windowLimiter';
import type { UploadedFile } from '../../services/attachments';
import { publicStatus } from '../../services/status';
import { checkSubmitKey, publicSubmitConfig, submitTicket } from '../../services/submit';
import { saveUploadPart, tooLarge } from '../uploads';
import { parse } from '../util';

/** Per address (IPv6 by /64): 5 tickets per 10 minutes. Overall: 30 per hour. */
export const SUBMIT_LIMITS = { perClient: { max: 5, windowMs: 10 * 60_000 }, overall: { max: 30, windowMs: 60 * 60_000 } };
/**
 * Status links, per address only: generous, since everyone behind one proxy shares an address, and
 * an overall cap would let one client lock everybody out.
 */
export const STATUS_LIMIT = { max: 60, windowMs: 60_000 };

const keyParam = (req: FastifyRequest) => String((req.params as { key?: string }).key ?? '');

export function registerSubmitRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { ctx, config } = deps;
  const perClient = new WindowLimiter(ctx.clock, SUBMIT_LIMITS.perClient.max, SUBMIT_LIMITS.perClient.windowMs);
  const overall = new WindowLimiter(ctx.clock, SUBMIT_LIMITS.overall.max, SUBMIT_LIMITS.overall.windowMs);
  const statusLimiter = new WindowLimiter(ctx.clock, STATUS_LIMIT.max, STATUS_LIMIT.windowMs);

  app.get('/api/public/submit/:key', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return publicSubmitConfig(ctx, keyParam(req), config.maxUploadBytes);
  });

  app.get('/api/public/status/:id/:sig', async (req) => {
    const r = statusLimiter.take(clientKey(req.ip));
    if (!r.ok) throw new AppError(429, 'rate_limited', 'Too many requests from here right now. Try again in a minute.', { retryAfterSec: r.retryAfterSec });
    const { id = '', sig = '' } = req.params as { id?: string; sig?: string };
    return publicStatus(ctx, id, sig);
  });

  app.post('/api/public/submit/:key', async (req, reply) => {
    const key = keyParam(req);
    checkSubmitKey(ctx, key); // before reading any upload
    if (!req.isMultipart()) throw badRequest('validation', 'Expected a multipart/form-data form');
    for (const limiter of [perClient.take(clientKey(req.ip)), overall.take('all')]) {
      if (!limiter.ok) {
        throw new AppError(429, 'rate_limited', 'Too many tickets from here right now. Try again a little later.', {
          retryAfterSec: limiter.retryAfterSec,
        });
      }
    }

    mkdirSync(config.tmpDir, { recursive: true });
    const tmpPaths: string[] = [];
    const files: UploadedFile[] = [];
    let data: unknown = undefined;
    try {
      const parts = req.parts({ limits: { fileSize: config.maxUploadBytes, files: LIMITS.submitFiles, fields: 2, parts: LIMITS.submitFiles + 2 } });
      for await (const part of parts) {
        if (part.type === 'file') {
          if (part.fieldname !== 'screenshots') {
            part.file.resume();
            continue;
          }
          files.push(await saveUploadPart(part, config.tmpDir, config.maxUploadBytes, tmpPaths));
        } else if (part.fieldname === 'data') {
          try {
            data = JSON.parse(String(part.value));
          } catch {
            throw badRequest('validation', 'The form data isn’t valid JSON');
          }
        }
      }
      const body = parse(SubmitBody, data);
      return reply.status(201).send(submitTicket(ctx, key, body, files, config.attachmentsDir));
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'FST_REQ_FILE_TOO_LARGE') throw tooLarge(config.maxUploadBytes);
      if (code === 'FST_FILES_LIMIT' || code === 'FST_PARTS_LIMIT') {
        throw new AppError(413, 'too_large', `Add at most ${LIMITS.submitFiles} screenshots`);
      }
      throw err;
    } finally {
      for (const p of tmpPaths) rmSync(p, { force: true });
    }
  });
}

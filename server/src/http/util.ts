import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { AppError, notFound } from '../errors';

/** Validates input with a shared zod schema; failures become 400 { error: 'validation', details }. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path.length ? `${first.path.join('.')}: ` : '';
    throw new AppError(400, 'validation', `${where}${first?.message ?? 'Invalid request'}`, {
      details: result.error.issues,
    });
  }
  return result.data;
}

/** Reads the numeric :id route param; anything else is a 404. */
export function idParam(req: FastifyRequest, name = 'id'): number {
  const raw = (req.params as Record<string, string>)[name];
  const n = Number(raw);
  if (!raw || !Number.isInteger(n) || n <= 0) throw notFound();
  return n;
}

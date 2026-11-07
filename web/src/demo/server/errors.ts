// The demo's copy of server/src/errors.ts and the parse()/idParam() helpers in server/src/http/util.ts.
// Same codes, statuses and message format, so the app shows the demo's errors exactly as it shows
// the real server's.

import type { z } from 'zod';

export class DemoError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DemoError';
  }
}

export const notFound = (message = 'Not found') => new DemoError(404, 'not_found', message);
export const badRequest = (code: string, message: string, extra?: Record<string, unknown>) =>
  new DemoError(400, code, message, extra);
export const conflict = (code: string, message: string, extra?: Record<string, unknown>) =>
  new DemoError(409, code, message, extra);

/** What a feature that needs the real server answers in the demo. */
export const DEMO_UNAVAILABLE_CODE = 'demo_unavailable';
export const notInDemo = (what: string) =>
  new DemoError(400, DEMO_UNAVAILABLE_CODE, `Not available in the demo: ${what}`);

/** Validates input with a shared zod schema; failures become 400 { error: 'validation', details }. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path.length ? `${first.path.join('.')}: ` : '';
    throw new DemoError(400, 'validation', `${where}${first?.message ?? 'Invalid request'}`, {
      details: result.error.issues,
    });
  }
  return result.data;
}

/** A numeric route param; anything else is a 404, like the server. */
export function idParam(params: Record<string, string>, name = 'id'): number {
  const raw = params[name];
  const n = Number(raw);
  if (!raw || !Number.isInteger(n) || n <= 0) throw notFound();
  return n;
}

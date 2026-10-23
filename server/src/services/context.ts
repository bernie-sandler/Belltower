import type { Clock } from '../clock';
import type { DB } from '../db/connection';

/** Everything a service needs. One per process (tests make their own). */
export interface Ctx {
  db: DB;
  clock: Clock;
  /** IANA time zone used for local dates (due dates, calendar days, recurrence). */
  tz: string;
}

export function nowIso(ctx: Ctx): string {
  return ctx.clock.now().toISOString();
}

/** Runs fn in a transaction (a savepoint when already inside one). */
export function tx<T>(ctx: Ctx, fn: () => T): T {
  return ctx.db.transaction(fn)();
}

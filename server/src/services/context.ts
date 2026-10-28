import type { Clock } from '../clock';
import type { Priority, Severity } from '@tt/shared';
import type { DB } from '../db/connection';

/** Everything a service needs. One per process (tests make their own). */
export interface Ctx {
  db: DB;
  clock: Clock;
  /** IANA time zone used for local dates (due dates, calendar days, recurrence). */
  tz: string;
  /**
   * Things other parts of the app may want to react to (Discord notifications). Called inside the
   * change's transaction, so listeners must defer their work and re-check that the card exists.
   */
  emit?: (event: AppEvent) => void;
}

export type AppEvent =
  /** `external`: from the submit page or an API token (`via` says which). */
  | { type: 'card_created'; cardId: number; external: boolean; via?: string }
  | { type: 'card_blocked'; cardId: number; blockerIds: number[] }
  /** Priority or severity changed, from → to (listeners decide whether it became urgent). */
  | {
      type: 'card_raised';
      cardId: number;
      from: { priority: Priority | null; severity: Severity | null };
      to: { priority: Priority | null; severity: Severity | null };
    };

export function nowIso(ctx: Ctx): string {
  return ctx.clock.now().toISOString();
}

/** Runs fn in a transaction (a savepoint when already inside one). */
export function tx<T>(ctx: Ctx, fn: () => T): T {
  return ctx.db.transaction(fn)();
}

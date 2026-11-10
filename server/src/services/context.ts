import type { Clock } from '../clock';
import type { Actor, Priority, Severity } from '@tt/shared';
import type { DB } from '../db/connection';

/**
 * Everything a service needs. The process has one base context (tests make their own); each
 * request gets a view of it that adds who is acting (withActor).
 */
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
  /** Who is acting. Absent means the system (startup, timers, recurring templates, tests). */
  actor?: Actor;
}

export type AppEvent = (
  /** `external`: from the submit page or an API token (`via` says which). */
  | { type: 'card_created'; cardId: number; external: boolean; via?: string }
  | { type: 'card_blocked'; cardId: number; blockerIds: number[] }
  /** Priority or severity changed, from → to (listeners decide whether it became urgent). */
  | {
      type: 'card_raised';
      cardId: number;
      from: { priority: Priority | null; severity: Severity | null };
      to: { priority: Priority | null; severity: Severity | null };
    }
) & {
  /** Who caused it. Listeners run after the commit on the base context, so the event carries it. */
  actor?: Actor;
};

/**
 * A view of `base` acting as `actor`. `db` and `emit` are read from and written to `base` on every
 * access, never copied: a restore closes the database and puts a new handle on the base context,
 * and a copy would keep using the closed one.
 */
export function withActor(base: Ctx, actor: Actor): Ctx {
  return {
    get db() {
      return base.db;
    },
    set db(db: DB) {
      base.db = db;
    },
    get emit() {
      return base.emit;
    },
    set emit(fn: Ctx['emit']) {
      base.emit = fn;
    },
    get clock() {
      return base.clock;
    },
    get tz() {
      return base.tz;
    },
    actor,
  };
}

/** The person acting (a token acts for its owner), or null for the system and the public. */
export function actorUserId(ctx: Ctx): number | null {
  const a = ctx.actor;
  return a?.kind === 'user' ? a.userId : a?.kind === 'token' ? a.userId : null;
}

/** The token acting, or null. */
export function actorTokenId(ctx: Ctx): number | null {
  return ctx.actor?.kind === 'token' ? ctx.actor.tokenId : null;
}

export function nowIso(ctx: Ctx): string {
  return ctx.clock.now().toISOString();
}

/** Runs fn in a transaction (a savepoint when already inside one). */
export function tx<T>(ctx: Ctx, fn: () => T): T {
  return ctx.db.transaction(fn)();
}

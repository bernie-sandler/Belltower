// Which Belltower version this install runs, and the one it was last upgraded from. The web app's
// "What's new" dialog uses `upgradedFrom` to tell an upgrade from a fresh install on a device that has
// never opened Belltower since the dialog existed (1.6.0).
//
// Settings keys (private to the install: not exported, kept on restore, see backup.ts):
//  - app_version:   the version that last started.
//  - upgraded_from: the version before the last version change, or UPGRADED_FROM_UNKNOWN for an
//                   install that predates app_version. Absent on an install that has never upgraded.

import { getSetting, setSetting } from '../db/connection';
import type { Ctx } from './context';

export const APP_VERSION_KEY = 'app_version';
export const UPGRADED_FROM_KEY = 'upgraded_from';
/** An install from before 1.6.0, which didn't record its version. */
export const UPGRADED_FROM_UNKNOWN = 'before 1.6.0';

/**
 * Call once at startup, after prepareData. `fresh`: this start created the install (it seeded the
 * defaults just now). A dev build ('dev') records nothing.
 */
export function recordAppVersion(ctx: Ctx, version: string, fresh: boolean): void {
  if (version === 'dev') return;
  const previous = getSetting(ctx.db, APP_VERSION_KEY);
  if (previous === version) return;
  if (previous !== null) setSetting(ctx.db, UPGRADED_FROM_KEY, previous);
  else if (!fresh) setSetting(ctx.db, UPGRADED_FROM_KEY, UPGRADED_FROM_UNKNOWN);
  setSetting(ctx.db, APP_VERSION_KEY, version);
}

/** The version this install was last upgraded from, or null when it has never been upgraded. */
export function upgradedFrom(ctx: Ctx): string | null {
  return getSetting(ctx.db, UPGRADED_FROM_KEY);
}

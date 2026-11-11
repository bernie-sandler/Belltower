// What startup does to the data after migrating: seed a new install, number cards from before
// ticket numbers existed, rebuild the search index if it doesn't match the cards, and give the
// Teams switch its first value. Shared by index.ts and the upgrade tests, so the tests exercise the
// real startup path.

import { assignTicketNumbers } from '../services/cards';
import type { Ctx } from '../services/context';
import { rebuildSearch, searchIndexLooksConsistent } from '../services/search';
import { backfillTeamsSetting } from '../services/settings';
import { seedDefaults } from './seed';

export interface PrepareResult {
  seeded: boolean;
  /** Cards that got a ticket number now. */
  numbered: number;
  /** Cards reindexed, or null when the search index was already consistent. */
  reindexed: number | null;
  /** The Teams switch's first value (see backfillTeamsSetting), or null when it already had one. */
  teams: boolean | null;
}

export function prepareData(ctx: Ctx): PrepareResult {
  const seeded = seedDefaults(ctx);
  const numbered = assignTicketNumbers(ctx);
  const reindexed = searchIndexLooksConsistent(ctx) ? null : rebuildSearch(ctx);
  const teams = backfillTeamsSetting(ctx);
  return { seeded, numbered, reindexed, teams };
}

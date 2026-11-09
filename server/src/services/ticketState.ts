// A ticket's state as people outside the board see it: the status page now, the dashboard summary
// (GET /api/v1/summary). Kept in one place so they always agree. Checked in this order:
//   done         completed
//   waiting      in the blocked column, or blocked by an open card
//   received     in the triage column, or the column the submit page files into
//   in_progress  anywhere else

import type { TicketState } from '@tt/shared';
import { stmt } from '../db/connection';
import { cardsWithOpenBlockers, openBlockers } from './cardParts';
import { getBlockedColumnId, getRoleColumn } from './columns';
import type { Ctx } from './context';
import { getSubmitSettings } from './settings';

export interface StateColumns {
  blocked: number | null;
  received: ReadonlySet<number>;
}

/** The columns the rule looks at (read once when classifying many cards). */
export function stateColumns(ctx: Ctx): StateColumns {
  const received = new Set([getRoleColumn(ctx, 'triage').id]);
  const submitColumn = getSubmitSettings(ctx).columnId;
  if (submitColumn !== null && stmt(ctx.db, 'SELECT 1 FROM columns WHERE id = ?').get(submitColumn)) received.add(submitColumn);
  return { blocked: getBlockedColumnId(ctx), received };
}

type StateCard = { id: number; column_id: number; completed_at: string | null };

function classify(card: StateCard, cols: StateColumns, hasOpenBlocker: boolean): TicketState {
  if (card.completed_at) return 'done';
  if (card.column_id === cols.blocked || hasOpenBlocker) return 'waiting';
  if (cols.received.has(card.column_id)) return 'received';
  return 'in_progress';
}

export function ticketState(ctx: Ctx, card: StateCard, cols: StateColumns = stateColumns(ctx)): TicketState {
  return classify(card, cols, !card.completed_at && openBlockers(ctx, card.id).length > 0);
}

/** The same rule for many cards, with a fixed number of queries. */
export function ticketStates(ctx: Ctx, cards: readonly StateCard[]): TicketState[] {
  const cols = stateColumns(ctx);
  const blocked = cardsWithOpenBlockers(ctx);
  return cards.map((c) => classify(c, cols, blocked.has(c.id)));
}

// Manual work-log entries ("Swapped SATA power cable to drive 3"). They live in the append-only
// activity table: an edit first copies the previous body and time into activity_revisions, so the
// original text and every edit time are kept. Entries are never deleted; a wrong one is retracted
// (kept and shown struck through, but left out of the calendar and search).

import type { ActivityEntry, ActivityRevision } from '@tt/shared';
import { stmt } from '../db/connection';
import { badRequest, conflict, notFound } from '../errors';
import { toActivityEntry, type ActivityRow } from './activity';
import { FUTURE_SLACK_MS, getCardRow, getEditableCard, touchCard } from './cards';
import { actorTokenId, actorUserId, nowIso, tx, type Ctx } from './context';
import { reindexCard } from './search';

function assertNotFuture(ctx: Ctx, iso: string): void {
  if (Date.parse(iso) > ctx.clock.now().getTime() + FUTURE_SLACK_MS) {
    throw badRequest('validation', "A work-log time can't be in the future");
  }
}

export function getActivityEntry(ctx: Ctx, id: number): ActivityEntry {
  const row = stmt(
    ctx.db,
    `SELECT a.*, (SELECT count(*) FROM activity_revisions r WHERE r.activity_id = a.id) AS revision_count
       FROM activity a WHERE a.id = ?`,
  ).get(id) as ActivityRow | undefined;
  if (!row) throw notFound('Log entry not found');
  return toActivityEntry(row);
}

export function addWorklog(ctx: Ctx, cardId: number, input: { bodyMd: string; occurredAt?: string }): ActivityEntry {
  return tx(ctx, () => {
    getEditableCard(ctx, cardId);
    const now = nowIso(ctx);
    if (input.occurredAt) assertNotFuture(ctx, input.occurredAt);
    const id = Number(
      stmt(
        ctx.db,
        `INSERT INTO activity (card_id, kind, type, data, body_md, occurred_at, created_at, user_id, token_id)
         VALUES (?, 'worklog', 'worklog', '{}', ?, ?, ?, ?, ?)`,
      ).run(cardId, input.bodyMd, input.occurredAt ?? now, now, actorUserId(ctx), actorTokenId(ctx)).lastInsertRowid,
    );
    touchCard(ctx, cardId);
    reindexCard(ctx, cardId);
    return getActivityEntry(ctx, id);
  });
}

export function updateWorklog(
  ctx: Ctx,
  id: number,
  patch: { bodyMd?: string; occurredAt?: string; retracted?: boolean },
): ActivityEntry {
  return tx(ctx, () => {
    const row = stmt(ctx.db, 'SELECT * FROM activity WHERE id = ?').get(id) as ActivityRow | undefined;
    if (!row) throw notFound('Log entry not found');
    if (row.kind !== 'worklog') throw conflict('not_worklog', 'Only work-log entries can be edited');
    if (getCardRow(ctx, row.card_id).deleted_at) {
      throw conflict('card_deleted', 'This card is in the Trash; restore it before editing');
    }
    const now = nowIso(ctx);

    const body = patch.bodyMd ?? row.body_md!;
    const occurred = patch.occurredAt ?? row.occurred_at;
    if (patch.occurredAt) assertNotFuture(ctx, patch.occurredAt);
    const contentChanged = body !== row.body_md || occurred !== row.occurred_at;
    if (contentChanged) {
      stmt(
        ctx.db,
        'INSERT INTO activity_revisions (activity_id, body_md, occurred_at, revised_at, user_id) VALUES (?, ?, ?, ?, ?)',
      ).run(id, row.body_md, row.occurred_at, now, actorUserId(ctx));
      stmt(ctx.db, 'UPDATE activity SET body_md = ?, occurred_at = ?, edited_at = ? WHERE id = ?').run(
        body,
        occurred,
        now,
        id,
      );
    }
    if (patch.retracted !== undefined && patch.retracted !== (row.retracted_at !== null)) {
      stmt(ctx.db, 'UPDATE activity SET retracted_at = ? WHERE id = ?').run(patch.retracted ? now : null, id);
    }
    touchCard(ctx, row.card_id);
    reindexCard(ctx, row.card_id);
    return getActivityEntry(ctx, id);
  });
}

/** Earlier versions of an edited entry, oldest first (the first one is the original text). */
export function listRevisions(ctx: Ctx, id: number): ActivityRevision[] {
  getActivityEntry(ctx, id);
  const rows = stmt(
    ctx.db,
    'SELECT * FROM activity_revisions WHERE activity_id = ? ORDER BY revised_at, id',
  ).all(id) as { id: number; body_md: string; occurred_at: string; revised_at: string; user_id: number | null }[];
  return rows.map((r) => ({ id: r.id, bodyMd: r.body_md, occurredAt: r.occurred_at, revisedAt: r.revised_at, userId: r.user_id ?? null }));
}

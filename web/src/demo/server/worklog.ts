// Mirrors server/src/services/worklog.ts: work-log entries are never deleted; an edit keeps the
// previous version, and a wrong entry is retracted. Only the author or an admin may change one.

import type { ActivityEntry, ActivityRevision } from '@tt/shared';
import { recordEvent, toActivityEntry, userNamesOf } from './activity';
import { FUTURE_SLACK_MS, getCardRow, getEditableCard, touchCard } from './cards';
import { actorId, nextId, nowIso, type Ctx } from './db';
import { DemoError, badRequest, conflict, notFound } from './errors';
import { notifyNoteAdded, notifyNoteEdited } from './notifications';
import { actorIsAdmin } from './users';

function assertNotFuture(ctx: Ctx, iso: string): void {
  if (Date.parse(iso) > ctx.now().getTime() + FUTURE_SLACK_MS) {
    throw badRequest('validation', "A work-log time can't be in the future");
  }
}

function excerpt(body: string): string {
  const t = body.replace(/\s+/g, ' ').trim();
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
}

export function getActivityEntry(ctx: Ctx, id: number): ActivityEntry {
  const row = ctx.s.activity.find((a) => a.id === id);
  if (!row) throw notFound('Log entry not found');
  return toActivityEntry(ctx, row);
}

/** The author or an admin; entries without an author are admin-only. No actor (the seed) may. */
export function mayChangeWorklog(ctx: Ctx, authorId: number | null): boolean {
  if (ctx.userId === undefined) return true;
  if (actorIsAdmin(ctx)) return true;
  const me = actorId(ctx);
  return me !== null && authorId === me;
}

/** `quiet`: imported notes notify nobody and don't make the importer watch (as on the server). */
export function addWorklog(ctx: Ctx, cardId: number, input: { bodyMd: string; occurredAt?: string }, opts: { quiet?: boolean } = {}): ActivityEntry {
  getEditableCard(ctx, cardId);
  const now = nowIso(ctx);
  if (input.occurredAt) assertNotFuture(ctx, input.occurredAt);
  const id = nextId(ctx, 'activity');
  ctx.s.activity.push({
    id,
    cardId,
    kind: 'worklog',
    type: 'worklog',
    data: {},
    bodyMd: input.bodyMd,
    occurredAt: input.occurredAt ?? now,
    createdAt: now,
    editedAt: null,
    retractedAt: null,
    userId: actorId(ctx),
    tokenId: null,
  });
  touchCard(ctx, cardId);
  if (!opts.quiet) notifyNoteAdded(ctx, cardId, id, input.bodyMd);
  return getActivityEntry(ctx, id);
}

export function updateWorklog(
  ctx: Ctx,
  id: number,
  patch: { bodyMd?: string; occurredAt?: string; retracted?: boolean },
): ActivityEntry {
  const row = ctx.s.activity.find((a) => a.id === id);
  if (!row) throw notFound('Log entry not found');
  if (row.kind !== 'worklog') throw conflict('not_worklog', 'Only work-log entries can be edited');
  if (!mayChangeWorklog(ctx, row.userId)) {
    throw new DemoError(
      403,
      'forbidden',
      row.userId === null
        ? 'Only an admin can change entries from before people were added'
        : 'Only the person who wrote this entry, or an admin, can change it',
    );
  }
  if (getCardRow(ctx, row.cardId).deletedAt) {
    throw conflict('card_deleted', 'This card is in the Trash; restore it before editing');
  }
  const now = nowIso(ctx);
  const before = row.bodyMd ?? '';
  const body = patch.bodyMd ?? row.bodyMd!;
  const occurred = patch.occurredAt ?? row.occurredAt;
  if (patch.occurredAt) assertNotFuture(ctx, patch.occurredAt);
  if (body !== row.bodyMd || occurred !== row.occurredAt) {
    ctx.s.revisions.push({
      id: nextId(ctx, 'revisions'),
      activityId: id,
      bodyMd: row.bodyMd ?? '',
      occurredAt: row.occurredAt,
      revisedAt: now,
      userId: actorId(ctx),
    });
    row.bodyMd = body;
    row.occurredAt = occurred;
    row.editedAt = now;
  }
  if (patch.retracted !== undefined && patch.retracted !== (row.retractedAt !== null)) {
    row.retractedAt = patch.retracted ? now : null;
    recordEvent(ctx, row.cardId, patch.retracted ? 'worklog_retracted' : 'worklog_restored', { entryId: id, text: excerpt(body) });
  }
  // People newly @mentioned by the edit. A retracted note notifies nobody.
  if (body !== before && row.retractedAt === null) notifyNoteEdited(ctx, row.cardId, id, before, body);
  touchCard(ctx, row.cardId);
  return getActivityEntry(ctx, id);
}

/** Earlier versions of an edited entry, oldest first. */
export function listRevisions(ctx: Ctx, id: number): ActivityRevision[] {
  getActivityEntry(ctx, id);
  return ctx.s.revisions
    .filter((r) => r.activityId === id)
    .sort((a, b) => a.revisedAt.localeCompare(b.revisedAt) || a.id - b.id)
    .map((r) => ({
      id: r.id,
      bodyMd: r.bodyMd,
      occurredAt: r.occurredAt,
      revisedAt: r.revisedAt,
      userId: r.userId,
      ...userNamesOf(ctx, r.userId),
    }));
}

// Mirrors server/src/services/activity.ts.

import type { ActivityEntry, ActivityEventType, ColumnRef, LabelRef } from '@tt/shared';
import { actorId, nextId, nowIso, type ActivityRow, type Ctx } from './db';

export function recordEvent(ctx: Ctx, cardId: number, type: ActivityEventType, data: object = {}): number {
  const now = nowIso(ctx);
  const id = nextId(ctx, 'activity');
  ctx.s.activity.push({
    id,
    cardId,
    kind: 'event',
    type,
    // A copy, so later changes to the caller's objects can't rewrite history.
    data: JSON.parse(JSON.stringify(data)) as Record<string, unknown>,
    bodyMd: null,
    occurredAt: now,
    createdAt: now,
    editedAt: null,
    retractedAt: null,
    userId: actorId(ctx),
    tokenId: null,
  });
  return id;
}

export function toActivityEntry(ctx: Ctx, row: ActivityRow): ActivityEntry {
  return {
    id: row.id,
    cardId: row.cardId,
    kind: row.kind,
    type: row.type as ActivityEntry['type'],
    data: structuredClone(row.data),
    bodyMd: row.bodyMd,
    occurredAt: row.occurredAt,
    createdAt: row.createdAt,
    editedAt: row.editedAt,
    retractedAt: row.retractedAt,
    revisionCount: ctx.s.revisions.filter((r) => r.activityId === row.id).length,
    userId: row.userId,
    tokenId: row.tokenId,
  };
}

/** Newest first, by effective time. */
export function listActivity(ctx: Ctx, cardId: number): ActivityEntry[] {
  return ctx.s.activity
    .filter((a) => a.cardId === cardId)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id - a.id)
    .map((a) => toActivityEntry(ctx, a));
}

export function columnRef(col: { id: number; name: string; role: string | null }): ColumnRef {
  return { id: col.id, name: col.name, role: col.role as ColumnRef['role'] };
}

export function labelRef(l: { id: number; name: string; color: string }): LabelRef {
  return { id: l.id, name: l.name, color: l.color };
}

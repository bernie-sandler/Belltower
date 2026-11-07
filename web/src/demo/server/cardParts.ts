// Mirrors server/src/services/cardParts.ts: read-only helpers for a card's parts and summaries.

import type { CardKind, CardLink, CardSummary, Checklist, LinkDirection } from '@tt/shared';
import { byPosition, type CardRow, type Ctx, type LinkRow } from './db';
import { conflict } from './errors';
import { labelIdsOf } from './labels';

export function listChecklists(ctx: Ctx, cardId: number): Checklist[] {
  return ctx.s.checklists
    .filter((l) => l.cardId === cardId)
    .sort(byPosition)
    .map((l) => ({
      id: l.id,
      title: l.title,
      position: l.position,
      items: ctx.s.checklistItems
        .filter((i) => i.checklistId === l.id)
        .sort(byPosition)
        .map((i) => ({ id: i.id, text: i.text, checked: i.checked, checkedAt: i.checkedAt, position: i.position })),
    }));
}

export function columnName(ctx: Ctx, columnId: number): string {
  return ctx.s.columns.find((c) => c.id === columnId)?.name ?? '';
}

export function toSummary(ctx: Ctx, c: CardRow): CardSummary {
  return {
    id: c.id,
    ticketNo: c.ticketNo,
    kind: c.kind,
    title: c.title,
    columnId: c.columnId,
    columnName: columnName(ctx, c.columnId),
    labelIds: labelIdsOf(ctx, c.labelIds),
    completedAt: c.completedAt,
    archivedAt: c.archivedAt,
    deletedAt: c.deletedAt,
    updatedAt: c.updatedAt,
  };
}

export function findCard(ctx: Ctx, id: number): CardRow | undefined {
  return ctx.s.cards.find((c) => c.id === id);
}

export function cardSummary(ctx: Ctx, id: number): CardSummary | null {
  const c = findCard(ctx, id);
  return c ? toSummary(ctx, c) : null;
}

export type CardListStatus = 'board' | 'archived' | 'trashed' | 'live';

const STATUS_FILTER: Record<CardListStatus, (c: CardRow) => boolean> = {
  board: (c) => !c.deletedAt && !c.archivedAt,
  archived: (c) => !c.deletedAt && c.archivedAt !== null,
  trashed: (c) => c.deletedAt !== null,
  live: (c) => !c.deletedAt,
};

const STATUS_ORDER: Record<CardListStatus, (c: CardRow) => string> = {
  board: (c) => c.updatedAt,
  archived: (c) => c.archivedAt ?? '',
  trashed: (c) => c.deletedAt ?? '',
  live: (c) => c.updatedAt,
};

/** Card lists for the link picker, Archive and Trash. `q` matches titles and ticket numbers. */
export function listCards(
  ctx: Ctx,
  opts: { status: CardListStatus; q?: string; limit: number; kind?: CardKind },
): CardSummary[] {
  const q = opts.q?.trim().toLowerCase();
  const n = q ? Number(q.replace(/^#/, '')) : NaN;
  const key = STATUS_ORDER[opts.status];
  return ctx.s.cards
    .filter(STATUS_FILTER[opts.status])
    .filter((c) => !opts.kind || c.kind === opts.kind)
    .filter(
      (c) =>
        !q ||
        c.title.toLowerCase().includes(q) ||
        (c.ticketNo ?? '').toLowerCase().includes(q) ||
        (Number.isInteger(n) && n > 0 && c.id === n),
    )
    .sort((a, b) => key(b).localeCompare(key(a)) || b.id - a.id)
    .slice(0, opts.limit)
    .map((c) => toSummary(ctx, c));
}

/** Tickets filed under a work card (not in Trash): open ones first, then by board position. */
export function listChildren(ctx: Ctx, cardId: number): CardSummary[] {
  const colPos = (id: number) => ctx.s.columns.find((c) => c.id === id)?.position ?? 0;
  return ctx.s.cards
    .filter((c) => c.parentId === cardId && !c.deletedAt)
    .sort(
      (a, b) =>
        Number(a.completedAt !== null) - Number(b.completedAt !== null) ||
        colPos(a.columnId) - colPos(b.columnId) ||
        byPosition(a, b),
    )
    .map((c) => toSummary(ctx, c));
}

export function linkDirection(row: LinkRow, cardId: number): LinkDirection {
  if (row.type === 'relates') return 'relates';
  return row.fromCardId === cardId ? 'blocks' : 'blocked_by';
}

/** Links of a card to cards that aren't in the Trash, from this card's point of view. */
export function listLinks(ctx: Ctx, cardId: number): CardLink[] {
  const out: CardLink[] = [];
  const rows = ctx.s.links
    .filter((l) => l.fromCardId === cardId || l.toCardId === cardId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
  for (const r of rows) {
    const other = cardSummary(ctx, r.fromCardId === cardId ? r.toCardId : r.fromCardId);
    if (!other || other.deletedAt) continue;
    out.push({ id: r.id, direction: linkDirection(r, cardId), card: other });
  }
  return out;
}

/** Cards that block `cardId` and are still open: not done and not in the Trash. */
export function openBlockers(ctx: Ctx, cardId: number): { id: number; title: string }[] {
  return ctx.s.links
    .filter((k) => k.toCardId === cardId && k.type === 'blocks')
    .map((k) => findCard(ctx, k.fromCardId))
    .filter((b): b is CardRow => Boolean(b && !b.deletedAt && !b.completedAt))
    .sort((a, b) => a.id - b.id)
    .map((b) => ({ id: b.id, title: b.title }));
}

/** A blocked card can't be completed until every card blocking it is done. 409 `blocked`. */
export function assertNotBlocked(ctx: Ctx, card: { id: number; title: string }): void {
  const blockers = openBlockers(ctx, card.id);
  if (!blockers.length) return;
  const names = blockers
    .slice(0, 3)
    .map((b) => `#${b.id} “${b.title}”`)
    .join(', ');
  const more = blockers.length > 3 ? ` and ${blockers.length - 3} more` : '';
  throw conflict(
    'blocked',
    `“${card.title}” can't be completed while it's blocked by ${names}${more}. Finish ${blockers.length === 1 ? 'that card' : 'those cards'} first.`,
    { blockers },
  );
}

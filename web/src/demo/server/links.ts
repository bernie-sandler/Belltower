// Mirrors server/src/services/links.ts: "related to" (stored once, lower id first) and
// "blocks / blocked by" (stored as from blocks to). Logged on both cards.

import type { CardDetail, LinkDirection } from '@tt/shared';
import { recordEvent } from './activity';
import { linkDirection } from './cardParts';
import { getCard, getCardRow, getEditableCard, parkIfBlocked, touchCard } from './cards';
import { nextId, nowIso, type Ctx, type LinkRow } from './db';
import { badRequest, conflict, notFound } from './errors';

const OPPOSITE: Record<LinkDirection, LinkDirection> = { relates: 'relates', blocks: 'blocked_by', blocked_by: 'blocks' };

function logBoth(
  ctx: Ctx,
  type: 'linked' | 'unlinked',
  link: LinkRow,
  a: { id: number; title: string },
  b: { id: number; title: string },
) {
  const dirA = linkDirection(link, a.id);
  recordEvent(ctx, a.id, type, { linkId: link.id, direction: dirA, otherId: b.id, otherTitle: b.title });
  recordEvent(ctx, b.id, type, { linkId: link.id, direction: OPPOSITE[dirA], otherId: a.id, otherTitle: a.title });
}

export function createLink(ctx: Ctx, cardId: number, otherId: number, direction: LinkDirection): CardDetail {
  if (cardId === otherId) throw badRequest('validation', "A card can't be linked to itself");
  const card = getEditableCard(ctx, cardId);
  const other = getCardRow(ctx, otherId);
  if (other.deletedAt) throw badRequest('invalid_target', 'That card is in the Trash');

  let from = cardId;
  let to = otherId;
  let type: 'relates' | 'blocks' = 'blocks';
  if (direction === 'relates') {
    type = 'relates';
    [from, to] = cardId < otherId ? [cardId, otherId] : [otherId, cardId];
  } else if (direction === 'blocked_by') {
    [from, to] = [otherId, cardId];
  }

  const existing = ctx.s.links.filter(
    (l) => (l.fromCardId === from && l.toCardId === to) || (l.fromCardId === to && l.toCardId === from),
  );
  if (existing.some((l) => l.type === type && l.fromCardId === from)) {
    throw conflict('duplicate_link', 'These cards are already linked that way');
  }
  if (type === 'blocks' && existing.some((l) => l.type === 'blocks')) {
    throw conflict('duplicate_link', 'These cards already have a blocking link the other way round');
  }

  if (type === 'blocks') {
    const blocked = to === cardId ? card : other;
    const blocker = to === cardId ? other : card;
    if (blocked.completedAt && !blocker.completedAt) {
      throw conflict('blocked', `“${blocked.title}” is already done, so an open card can't block it. Move it out of Done first.`);
    }
  }

  const link: LinkRow = { id: nextId(ctx, 'links'), fromCardId: from, toCardId: to, type, createdAt: nowIso(ctx) };
  ctx.s.links.push(link);
  logBoth(ctx, 'linked', link, card, other);
  touchCard(ctx, cardId);
  touchCard(ctx, otherId);
  if (type === 'blocks') parkIfBlocked(ctx, to);
  return getCard(ctx, cardId);
}

export function deleteLink(ctx: Ctx, cardId: number, linkId: number): CardDetail {
  const link = ctx.s.links.find((l) => l.id === linkId);
  if (!link || (link.fromCardId !== cardId && link.toCardId !== cardId)) throw notFound('Link not found');
  const card = getEditableCard(ctx, cardId);
  const other = getCardRow(ctx, link.fromCardId === cardId ? link.toCardId : link.fromCardId);
  ctx.s.links = ctx.s.links.filter((l) => l.id !== linkId);
  logBoth(ctx, 'unlinked', link, card, other);
  touchCard(ctx, card.id);
  touchCard(ctx, other.id);
  return getCard(ctx, cardId);
}

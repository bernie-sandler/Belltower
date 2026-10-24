// Card links: "related to" (symmetric, stored once with the lower id first) and "blocks / blocked
// by" (stored as from blocks to). Linking and unlinking are logged on both cards.

import type { CardDetail, LinkDirection } from '@tt/shared';
import { stmt } from '../db/connection';
import { badRequest, conflict, notFound } from '../errors';
import { recordEvent } from './activity';
import { linkDirection, type LinkRow } from './cardParts';
import { getCard, getCardRow, getEditableCard, parkIfBlocked, touchCard } from './cards';
import { nowIso, tx, type Ctx } from './context';
import { reindexCard } from './search';

const OPPOSITE: Record<LinkDirection, LinkDirection> = { relates: 'relates', blocks: 'blocked_by', blocked_by: 'blocks' };

function logBoth(ctx: Ctx, type: 'linked' | 'unlinked', link: LinkRow, a: { id: number; title: string }, b: { id: number; title: string }) {
  const dirA = linkDirection(link, a.id);
  recordEvent(ctx, a.id, type, { linkId: link.id, direction: dirA, otherId: b.id, otherTitle: b.title });
  recordEvent(ctx, b.id, type, { linkId: link.id, direction: OPPOSITE[dirA], otherId: a.id, otherTitle: a.title });
}

export function createLink(ctx: Ctx, cardId: number, otherId: number, direction: LinkDirection): CardDetail {
  return tx(ctx, () => {
    if (cardId === otherId) throw badRequest('validation', "A card can't be linked to itself");
    const card = getEditableCard(ctx, cardId);
    const other = getCardRow(ctx, otherId);
    if (other.deleted_at) throw badRequest('invalid_target', 'That card is in the Trash');

    let from = cardId;
    let to = otherId;
    let type: 'relates' | 'blocks' = 'blocks';
    if (direction === 'relates') {
      type = 'relates';
      [from, to] = cardId < otherId ? [cardId, otherId] : [otherId, cardId];
    } else if (direction === 'blocked_by') {
      [from, to] = [otherId, cardId];
    }

    const existing = stmt(
      ctx.db,
      `SELECT * FROM card_links WHERE (from_card_id = ? AND to_card_id = ?) OR (from_card_id = ? AND to_card_id = ?)`,
    ).all(from, to, to, from) as LinkRow[];
    if (existing.some((l) => l.type === type && l.from_card_id === from)) {
      throw conflict('duplicate_link', 'These cards are already linked that way');
    }
    if (type === 'blocks' && existing.some((l) => l.type === 'blocks')) {
      throw conflict('duplicate_link', 'These cards already have a blocking link the other way round');
    }

    if (type === 'blocks') {
      // A completed card can't become blocked by an open one; reopen it first.
      const blocked = to === cardId ? card : other;
      const blocker = to === cardId ? other : card;
      if (blocked.completed_at && !blocker.completed_at) {
        throw conflict(
          'blocked',
          `“${blocked.title}” is already done, so an open card can't block it. Move it out of Done first.`,
        );
      }
    }

    const id = Number(
      stmt(ctx.db, 'INSERT INTO card_links (from_card_id, to_card_id, type, created_at) VALUES (?, ?, ?, ?)').run(
        from,
        to,
        type,
        nowIso(ctx),
      ).lastInsertRowid,
    );
    const link = stmt(ctx.db, 'SELECT * FROM card_links WHERE id = ?').get(id) as LinkRow;
    logBoth(ctx, 'linked', link, card, other);
    for (const cid of [cardId, otherId]) {
      touchCard(ctx, cid);
      reindexCard(ctx, cid);
    }
    // A newly blocked card goes to the blocked column (when one is set).
    if (type === 'blocks') parkIfBlocked(ctx, to);
    return getCard(ctx, cardId);
  });
}

/** Removes a link; `cardId` is the card the request came from (its detail is returned). */
export function deleteLink(ctx: Ctx, cardId: number, linkId: number): CardDetail {
  return tx(ctx, () => {
    const link = stmt(ctx.db, 'SELECT * FROM card_links WHERE id = ?').get(linkId) as LinkRow | undefined;
    if (!link || (link.from_card_id !== cardId && link.to_card_id !== cardId)) throw notFound('Link not found');
    const card = getEditableCard(ctx, cardId);
    const other = getCardRow(ctx, link.from_card_id === cardId ? link.to_card_id : link.from_card_id);
    stmt(ctx.db, 'DELETE FROM card_links WHERE id = ?').run(linkId);
    logBoth(ctx, 'unlinked', link, card, other);
    touchCard(ctx, card.id);
    touchCard(ctx, other.id);
    return getCard(ctx, cardId);
  });
}

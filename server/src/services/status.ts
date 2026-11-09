// Status links: an unguessable address per ticket where the person who reported it can check on it
// without signing in (/submit/status/<id>/<sig>). Links are signed rather than stored, so there's
// nothing to migrate or back up beyond one secret; resetting the secret cuts off every link at once.
//
// The signature covers the card's creation time as well as its id: restoring an older backup can
// hand an id out again, and an old link must never show someone else's ticket.
//
// The status page lives under /submit/ on purpose: SECURITY.md tells people who publish the submit
// page to let only /submit/, /api/public/ and /assets/ past their proxy.

import type { PublicTicketStatus, StatusLinkInfo } from '@tt/shared';
import { createHmac, randomBytes } from 'node:crypto';
import { getSetting, setSetting, stmt } from '../db/connection';
import { conflict, notFound, pageNotFound } from '../errors';
import { safeEqual } from '../lib/safeEqual';
import type { Ctx } from './context';
import { getSubmitSettings } from './settings';
import { ticketState } from './ticketState';

/** Its own key, never inside submit_settings: that whole object is sent to the browser. */
export const STATUS_SECRET_KEY = 'status_link_secret';
const SIG_LENGTH = 22; // ~131 bits
const ID_PATTERN = /^[1-9]\d{0,11}$/;
const SIG_PATTERN = /^[\w-]{22}$/;

interface CardRow {
  id: number;
  kind: 'ticket' | 'work';
  ticket_no: string | null;
  title: string;
  column_id: number;
  resolution: string | null;
  completed_at: string | null;
  deleted_at: string | null;
  created_at: string;
}

const getRow = (ctx: Ctx, id: number) =>
  stmt(
    ctx.db,
    `SELECT id, kind, ticket_no, title, column_id, resolution, completed_at, deleted_at, created_at FROM cards WHERE id = ?`,
  ).get(id) as CardRow | undefined;

function sign(secret: string, id: number, createdAt: string): string {
  return createHmac('sha256', secret).update(`status:v1:${id}:${createdAt}`).digest('base64url').slice(0, SIG_LENGTH);
}

/** The signing secret; created only from the signed-in side or when a ticket is submitted. */
function secret(ctx: Ctx, create: boolean): string | null {
  const saved = getSetting(ctx.db, STATUS_SECRET_KEY);
  if (saved || !create) return saved;
  const fresh = randomBytes(32).toString('base64url');
  setSetting(ctx.db, STATUS_SECRET_KEY, fresh);
  return fresh;
}

/** Status links only answer while the submit page is on. */
const linksActive = (ctx: Ctx) => {
  const s = getSubmitSettings(ctx);
  return s.enabled && s.key !== null;
};

/** The status link for a ticket (Copy status link on the card, and the submit page's thank-you screen). */
export function statusLink(ctx: Ctx, cardId: number): StatusLinkInfo {
  const card = getRow(ctx, cardId);
  if (!card) throw notFound('Card not found');
  if (card.kind !== 'ticket') throw conflict('not_ticket', 'Only tickets have status links');
  if (card.deleted_at) throw conflict('deleted', 'This card is in the Trash');
  return { path: `/submit/status/${card.id}/${sign(secret(ctx, true)!, card.id, card.created_at)}`, active: linksActive(ctx) };
}

/** A new secret: every status link handed out so far stops working. */
export function resetStatusLinks(ctx: Ctx): void {
  setSetting(ctx.db, STATUS_SECRET_KEY, randomBytes(32).toString('base64url'));
}

/** What a status link shows. Every failure is the same 404 as a wrong submit-page key. */
export function publicStatus(ctx: Ctx, rawId: string, sig: string): PublicTicketStatus {
  if (!ID_PATTERN.test(rawId) || !SIG_PATTERN.test(sig) || !linksActive(ctx)) throw pageNotFound();
  const key = secret(ctx, false);
  if (!key) throw pageNotFound();
  const id = Number(rawId);
  const card = getRow(ctx, id);
  // Signed against a placeholder when there's no such card, so both cases take the same path.
  if (!safeEqual(sign(key, id, card?.created_at ?? ''), sig) || !card) throw pageNotFound();
  if (card.kind !== 'ticket' || card.deleted_at) throw pageNotFound();

  const state = ticketState(ctx, card);
  const changedAt =
    (stmt(
      ctx.db,
      `SELECT max(occurred_at) FROM activity
        WHERE card_id = ? AND kind = 'event'
          AND (type IN ('created', 'moved', 'completion_changed')
               OR (type = 'resolved' AND json_extract(data, '$.reason') IS NOT json_extract(data, '$.from')))`,
    )
      .pluck()
      .get(id) as string | null) ?? card.created_at;
  return {
    ticketNo: card.ticket_no,
    title: card.title,
    submittedAt: card.created_at,
    state,
    resolution: state === 'done' ? card.resolution : null,
    changedAt,
  };
}

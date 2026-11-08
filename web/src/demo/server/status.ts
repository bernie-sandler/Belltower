// Mirrors server/src/services/status.ts and ticketState.ts: ticket status links.
//
// The server signs links with HMAC-SHA256. The browser's HMAC (crypto.subtle) is async and demo
// routes are synchronous, so the demo signs with a small non-cryptographic hash instead. Everything
// here runs in this browser and nobody else can open its links, so there's nothing to protect.

import type { PublicTicketStatus, StatusLinkInfo, TicketState } from '@tt/shared';
import { openBlockers } from './cardParts';
import { getBlockedColumnId, getRoleColumn } from './columns';
import type { CardRow, Ctx } from './db';
import { conflict, notFound } from './errors';
import { newSubmitKey } from './settings';

const pageNotFound = () => notFound('This page doesn’t exist');
const ID_PATTERN = /^[1-9]\d{0,11}$/;
const SIG_PATTERN = /^[\w-]{22}$/;

function sign(secret: string, id: number, createdAt: string): string {
  const msg = `${secret}:status:v1:${id}:${createdAt}`;
  let out = '';
  for (let round = 0; out.length < 22; round++) {
    let h = 0x811c9dc5 ^ round;
    for (let i = 0; i < msg.length; i++) h = Math.imul(h ^ msg.charCodeAt(i), 0x01000193);
    out += (h >>> 0).toString(36).padStart(7, '0');
  }
  return out.slice(0, 22);
}

function secret(ctx: Ctx, create: boolean): string | null {
  const saved = ctx.s.settings.statusSecret ?? null;
  if (saved || !create) return saved;
  ctx.s.settings.statusSecret = newSubmitKey();
  return ctx.s.settings.statusSecret;
}

const linksActive = (ctx: Ctx) => ctx.s.settings.submit.enabled && ctx.s.settings.submit.key !== null;

export function ticketState(ctx: Ctx, card: CardRow): TicketState {
  if (card.completedAt) return 'done';
  if (card.columnId === getBlockedColumnId(ctx) || openBlockers(ctx, card.id).length > 0) return 'waiting';
  const submitColumn = ctx.s.settings.submit.columnId;
  if (card.columnId === getRoleColumn(ctx, 'triage').id || (submitColumn !== null && card.columnId === submitColumn)) return 'received';
  return 'in_progress';
}

export function statusLink(ctx: Ctx, cardId: number): StatusLinkInfo {
  const card = ctx.s.cards.find((c) => c.id === cardId);
  if (!card) throw notFound('Card not found');
  if (card.kind !== 'ticket') throw conflict('not_ticket', 'Only tickets have status links');
  if (card.deletedAt) throw conflict('deleted', 'This card is in the Trash');
  return { path: `/submit/status/${card.id}/${sign(secret(ctx, true)!, card.id, card.createdAt)}`, active: linksActive(ctx) };
}

export function resetStatusLinks(ctx: Ctx): void {
  ctx.s.settings.statusSecret = newSubmitKey();
}

export function publicStatus(ctx: Ctx, rawId: string, sig: string): PublicTicketStatus {
  if (!ID_PATTERN.test(rawId) || !SIG_PATTERN.test(sig) || !linksActive(ctx)) throw pageNotFound();
  const key = secret(ctx, false);
  if (!key) throw pageNotFound();
  const id = Number(rawId);
  const card = ctx.s.cards.find((c) => c.id === id);
  if (!card || sign(key, id, card.createdAt) !== sig || card.kind !== 'ticket' || card.deletedAt) throw pageNotFound();
  const state = ticketState(ctx, card);
  const changes = ctx.s.activity
    .filter(
      (a) =>
        a.cardId === id &&
        a.kind === 'event' &&
        (['created', 'moved', 'completion_changed'].includes(a.type) || (a.type === 'resolved' && a.data.reason !== a.data.from)),
    )
    .map((a) => a.occurredAt)
    .sort();
  return {
    ticketNo: card.ticketNo,
    title: card.title,
    submittedAt: card.createdAt,
    state,
    resolution: state === 'done' ? card.resolution : null,
    changedAt: changes.at(-1) ?? card.createdAt,
  };
}

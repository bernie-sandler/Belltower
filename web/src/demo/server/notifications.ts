// Mirrors server/src/services/notifications.ts: the bell, watching and @mentions. The demo can't
// send anything, so personal Discord and ntfy stay on the server (routes.ts answers notInDemo for
// them); everything else works the same.

import {
  findMentions,
  noteExcerpt,
  notificationText,
  notifyPrefsFrom,
  type MarkNotificationsReadBody,
  type NotificationData,
  type NotificationItem,
  type NotificationsQuery,
  type NotificationsResponse,
  type NotificationType,
  type PersonalNotifyBody,
  type PersonalNotifySettings,
} from '@tt/shared';
import { actorId, nextId, nowIso, type Ctx, type NotificationRow } from './db';
import { getUser } from './users';

const DAY_MS = 86_400_000;

/** The person acting in person (the demo has no tokens): never told about their own action. */
const selfId = (ctx: Ctx) => ctx.userId ?? null;

const activePeople = (ctx: Ctx) => ctx.s.users.filter((u) => u.disabledAt === null);

interface NotifyInput {
  cardId: number;
  activityId: number;
  type: NotificationType;
  userIds: Iterable<number>;
  data: Omit<NotificationData, 'actorName' | 'hidden'>;
}

/** Returns the new rows: their ids and whom each is for. */
export function notifyPeople(ctx: Ctx, input: NotifyInput): { id: number; userId: number }[] {
  const me = selfId(ctx);
  const ids = new Set([...input.userIds].filter((id) => id !== me));
  if (!ids.size) return [];
  const actor = me === null ? undefined : ctx.s.users.find((u) => u.id === me);
  const data: NotificationData = { ...input.data, actorName: actor?.displayName ?? null };
  const now = nowIso(ctx);
  const out: { id: number; userId: number }[] = [];
  for (const p of activePeople(ctx).filter((u) => ids.has(u.id))) {
    const picks = notifyPrefsFrom(p.notifyPrefs)[input.type];
    if (!picks.inApp && !picks.discord && !picks.ntfy) continue;
    // The unique (user, activity, type) index.
    if (ctx.s.notifications.some((n) => n.userId === p.id && n.activityId === input.activityId && n.type === input.type)) continue;
    const id = nextId(ctx, 'notifications');
    ctx.s.notifications.push({
      id,
      userId: p.id,
      cardId: input.cardId,
      activityId: input.activityId,
      type: input.type,
      actorUserId: actorId(ctx),
      data: picks.inApp ? { ...data } : { ...data, hidden: true },
      createdAt: now,
      readAt: picks.inApp ? null : now,
    });
    out.push({ id, userId: p.id });
  }
  return out;
}

const told = (rows: { userId: number }[]) => new Set(rows.map((r) => r.userId));

// ---- watching ----

export function watchCard(ctx: Ctx, cardId: number, userId: number): void {
  if (ctx.s.watchers.some((w) => w.cardId === cardId && w.userId === userId)) return;
  ctx.s.watchers.push({ cardId, userId, createdAt: nowIso(ctx) });
}

export function unwatchCard(ctx: Ctx, cardId: number, userId: number): void {
  ctx.s.watchers = ctx.s.watchers.filter((w) => !(w.cardId === cardId && w.userId === userId));
}

export function isWatching(ctx: Ctx, cardId: number): boolean {
  const me = actorId(ctx);
  return me !== null && ctx.s.watchers.some((w) => w.cardId === cardId && w.userId === me);
}

function watchersOf(ctx: Ctx, cardId: number): number[] {
  const active = new Set(activePeople(ctx).map((u) => u.id));
  return ctx.s.watchers.filter((w) => w.cardId === cardId && active.has(w.userId)).map((w) => w.userId);
}

export function watchOwnNewCard(ctx: Ctx, cardId: number): void {
  const me = actorId(ctx);
  if (me !== null) watchCard(ctx, cardId, me);
}

// ---- what notifies whom ----

export function notifyMoved(ctx: Ctx, cardId: number, activityId: number, move: { to: string; done?: boolean; reopened?: boolean; blocked?: boolean }): void {
  const data = { what: 'moved' as const, to: move.to, ...(move.done ? { done: true } : {}), ...(move.reopened ? { reopened: true } : {}), ...(move.blocked ? { blocked: true } : {}) };
  notifyPeople(ctx, { cardId, activityId, type: 'watching', userIds: watchersOf(ctx, cardId), data });
}

export function notifyAssigned(ctx: Ctx, cardId: number, activityId: number, change: { to: { id: number; name: string } | null; fromName: string | null }): void {
  const { to } = change;
  let assigned = new Set<number>();
  if (to) {
    watchCard(ctx, cardId, to.id);
    assigned = told(notifyPeople(ctx, { cardId, activityId, type: 'assigned', userIds: [to.id], data: {} }));
  }
  const took = to !== null && to.id === actorId(ctx);
  notifyPeople(ctx, {
    cardId,
    activityId,
    type: 'watching',
    userIds: watchersOf(ctx, cardId).filter((id) => !assigned.has(id)),
    data: { what: 'assigned', toName: to?.name ?? null, fromName: change.fromName, ...(took ? { took: true } : {}) },
  });
}

function mentionedPeople(ctx: Ctx, md: string): number[] {
  if (!md.includes('@')) return [];
  const byName = new Map(activePeople(ctx).map((u) => [u.username.toLowerCase(), u.id]));
  return findMentions(md, new Set(byName.keys())).map((n) => byName.get(n)!);
}

export function notifyNoteAdded(ctx: Ctx, cardId: number, entryId: number, md: string): void {
  const me = actorId(ctx);
  if (me !== null) watchCard(ctx, cardId, me);
  const mentioned = mentionedPeople(ctx, md);
  for (const id of mentioned) watchCard(ctx, cardId, id);
  const excerpt = noteExcerpt(md);
  const mentionedTold = told(notifyPeople(ctx, { cardId, activityId: entryId, type: 'mentioned', userIds: mentioned, data: { excerpt } }));
  notifyPeople(ctx, {
    cardId,
    activityId: entryId,
    type: 'watching',
    userIds: watchersOf(ctx, cardId).filter((id) => !mentionedTold.has(id)),
    data: { what: 'note', excerpt },
  });
}

export function notifyNoteEdited(ctx: Ctx, cardId: number, entryId: number, before: string, after: string): void {
  const earlier = new Set(mentionedPeople(ctx, before));
  const added = mentionedPeople(ctx, after).filter((id) => !earlier.has(id));
  if (!added.length) return;
  for (const id of added) watchCard(ctx, cardId, id);
  notifyPeople(ctx, { cardId, activityId: entryId, type: 'mentioned', userIds: added, data: { excerpt: noteExcerpt(after) } });
}

export function notifyNewUnassigned(ctx: Ctx, cardId: number, activityId: number, via: string | undefined): void {
  notifyPeople(ctx, { cardId, activityId, type: 'new_unassigned', userIds: activePeople(ctx).map((u) => u.id), data: via ? { via } : {} });
}

// ---- the bell ----

/** Shown in the bell: not turned off there, not about a note retracted since. */
function inBell(ctx: Ctx, n: NotificationRow): boolean {
  if (n.data.hidden) return false;
  return !ctx.s.activity.some((a) => a.id === n.activityId && a.retractedAt !== null);
}

function toItem(ctx: Ctx, n: NotificationRow): NotificationItem {
  const card = ctx.s.cards.find((c) => c.id === n.cardId);
  const data = n.data as NotificationData;
  return {
    id: n.id,
    type: n.type as NotificationType,
    cardId: n.cardId,
    ticketNo: card?.ticketNo ?? null,
    cardTitle: card?.title ?? '',
    actorName: data.actorName ?? (n.type === 'new_unassigned' ? (data.via ?? null) : null),
    text: notificationText(n.type, data),
    createdAt: n.createdAt,
    readAt: n.readAt,
  };
}

export function listNotifications(ctx: Ctx, userId: number, q: NotificationsQuery): NotificationsResponse {
  const mine = ctx.s.notifications.filter((n) => n.userId === userId && inBell(ctx, n)).sort((a, b) => b.id - a.id);
  return {
    items: mine
      .filter((n) => n.id > (q.after ?? 0))
      .slice(0, q.limit)
      .map((n) => toItem(ctx, n)),
    unread: mine.filter((n) => n.readAt === null).length,
    latestId: mine[0]?.id ?? 0,
  };
}

export function markNotificationsRead(ctx: Ctx, userId: number, body: MarkNotificationsReadBody): number {
  const now = nowIso(ctx);
  const ids = new Set(body.ids ?? []);
  for (const n of ctx.s.notifications) {
    if (n.userId === userId && n.readAt === null && (body.all || ids.has(n.id) || n.cardId === body.cardId)) n.readAt = now;
  }
  return ctx.s.notifications.filter((n) => n.userId === userId && n.readAt === null && inBell(ctx, n)).length;
}

/** Read ones after 30 days, any after 90 (the server does this on a timer; the demo when the board loads). */
export function pruneNotifications(ctx: Ctx): void {
  const now = ctx.now().getTime();
  const readCutoff = new Date(now - 30 * DAY_MS).toISOString();
  const anyCutoff = new Date(now - 90 * DAY_MS).toISOString();
  ctx.s.notifications = ctx.s.notifications.filter((n) => !((n.readAt !== null && n.createdAt < readCutoff) || n.createdAt < anyCutoff));
}

// ---- your settings ----

export function personalNotifySettings(ctx: Ctx, userId: number): PersonalNotifySettings {
  const u = getUser(ctx, userId);
  // The demo's install channels can't be given an address, so neither can carry personal messages.
  return { discordUserId: u.discordUserId, ntfyTopic: u.ntfyTopic, prefs: notifyPrefsFrom(u.notifyPrefs), install: { discord: false, ntfy: false } };
}

/** Saves what goes where; a Discord ID or ntfy topic needs the server (the caller checks). */
export function updatePersonalNotify(ctx: Ctx, userId: number, body: PersonalNotifyBody): PersonalNotifySettings {
  const u = getUser(ctx, userId);
  u.discordUserId = body.discordUserId;
  u.ntfyTopic = body.ntfyTopic;
  u.notifyPrefs = structuredClone(body.prefs);
  return personalNotifySettings(ctx, userId);
}

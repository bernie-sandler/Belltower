// Personal notifications (1.5): the bell in the app, plus a Discord mention and a personal ntfy topic
// for those who set them up (Account → Notifications).
//
// Rows are written inside the change's transaction (notifyPeople), so a rolled-back change notifies
// nobody. Then one `people_notified` event goes out, and the Notifier (notify.ts) delivers to
// personal channels after the commit, a few seconds later and combined per person.
//
// Who is told:
//  - assigned: the new assignee;
//  - mentioned: @username in a work-log note (only new names when a note is edited);
//  - watching: people watching the card, on a new note, a move (done and reopened included) or an
//    assignee change;
//  - new_unassigned: everyone who opted in, when an outside ticket arrives with no assignee.
// Never the person acting (a token acts for its owner, who *is* told), never deactivated people, and
// once per person and change (a unique index). Someone told they were mentioned or assigned isn't
// also told as a watcher; someone who turned those off still hears it as a watcher.
//
// You watch a card when you create it in the app, are assigned it, are mentioned on it or write a
// note on it. Notifications aren't in backups; old ones are pruned (pruneNotifications).

import {
  NtfyTopic,
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
  type NotifyPrefs,
  type PersonalNotifyBody,
  type PersonalNotifySettings,
} from '@tt/shared';
import { stmt } from '../db/connection';
import { badRequest } from '../errors';
import { actorUserId, nowIso, type Ctx } from './context';
import { channelReady, getChannelSettings, getDiscordSettings } from './settings';
import { getUser } from './users';

/** Read notifications are pruned this many days after they were made… */
export const READ_KEEP_DAYS = 30;
/** …and unread ones after this many. */
export const UNREAD_KEEP_DAYS = 90;

const DAY_MS = 86_400_000;

/** The person to leave out: whoever is acting in person. A token's owner is still told. */
function selfId(ctx: Ctx): number | null {
  return ctx.actor?.kind === 'user' ? ctx.actor.userId : null;
}

/** Who did it, for the notification's text: a person's name, or the token they used. */
function actorName(ctx: Ctx): string | null {
  const a = ctx.actor;
  if (a?.kind === 'user') {
    return (stmt(ctx.db, 'SELECT display_name FROM users WHERE id = ?').pluck().get(a.userId) as string | undefined) ?? null;
  }
  if (a?.kind === 'token') {
    const name = stmt(ctx.db, 'SELECT name FROM api_tokens WHERE id = ?').pluck().get(a.tokenId) as string | undefined;
    return name ? `API token “${name}”` : 'An API token';
  }
  return null;
}

export function prefsOf(raw: string | null | undefined): NotifyPrefs {
  try {
    return notifyPrefsFrom(raw ? JSON.parse(raw) : {});
  } catch {
    return notifyPrefsFrom({});
  }
}

interface NotifyInput {
  cardId: number;
  /** The activity row this is about (the note, the move, the assignment). */
  activityId: number;
  type: NotificationType;
  userIds: Iterable<number>;
  data: Omit<NotificationData, 'actorName' | 'hidden'>;
}

/**
 * Writes one notification per person (inside the caller's transaction) and announces them for
 * delivery to personal channels. Leaves out the person acting, deactivated people and people who
 * turned this event off everywhere; someone who turned off only the bell gets a row marked hidden
 * (and read), so personal channels still hear about it and the unique index still stops repeats.
 * Returns the new rows: their ids and whom each is for.
 */
export function notifyPeople(ctx: Ctx, input: NotifyInput): { id: number; userId: number }[] {
  const me = selfId(ctx);
  const userIds = [...new Set(input.userIds)].filter((id) => id !== me);
  if (!userIds.length) return [];
  const people = stmt(ctx.db, 'SELECT id, notify_prefs FROM users WHERE id IN (SELECT value FROM json_each(?)) AND disabled_at IS NULL').all(
    JSON.stringify(userIds),
  ) as { id: number; notify_prefs: string }[];
  const now = nowIso(ctx);
  const data: NotificationData = { ...input.data, actorName: actorName(ctx) };
  const insert = stmt(
    ctx.db,
    `INSERT OR IGNORE INTO notifications (user_id, card_id, activity_id, type, actor_user_id, data, created_at, read_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const written: { id: number; userId: number }[] = [];
  for (const p of people) {
    const picks = prefsOf(p.notify_prefs)[input.type];
    if (!picks.inApp && !picks.discord && !picks.ntfy) continue;
    const row = picks.inApp ? data : { ...data, hidden: true };
    const info = insert.run(p.id, input.cardId, input.activityId, input.type, actorUserId(ctx), JSON.stringify(row), now, picks.inApp ? null : now);
    if (info.changes) written.push({ id: Number(info.lastInsertRowid), userId: p.id });
  }
  if (written.length) ctx.emit?.({ type: 'people_notified', ids: written.map((w) => w.id), actor: ctx.actor });
  return written;
}

/** The people a notifyPeople call wrote a row for. */
const told = (rows: { userId: number }[]) => new Set(rows.map((r) => r.userId));

// ---- watching ----

export function watchCard(ctx: Ctx, cardId: number, userId: number): void {
  stmt(ctx.db, 'INSERT OR IGNORE INTO card_watchers (card_id, user_id, created_at) VALUES (?, ?, ?)').run(cardId, userId, nowIso(ctx));
}

export function unwatchCard(ctx: Ctx, cardId: number, userId: number): void {
  stmt(ctx.db, 'DELETE FROM card_watchers WHERE card_id = ? AND user_id = ?').run(cardId, userId);
}

/** Whether the person acting (a token: its owner) watches the card. */
export function isWatching(ctx: Ctx, cardId: number): boolean {
  const me = actorUserId(ctx);
  return me !== null && stmt(ctx.db, 'SELECT EXISTS (SELECT 1 FROM card_watchers WHERE card_id = ? AND user_id = ?)').pluck().get(cardId, me) === 1;
}

/** Active people watching a card. */
function watchersOf(ctx: Ctx, cardId: number): number[] {
  return stmt(
    ctx.db,
    'SELECT w.user_id FROM card_watchers w JOIN users u ON u.id = w.user_id WHERE w.card_id = ? AND u.disabled_at IS NULL',
  )
    .pluck()
    .all(cardId) as number[];
}

/** The person acting watches a card they made in the app (not through a token, an import or the submit page). */
export function watchOwnNewCard(ctx: Ctx, cardId: number): void {
  if (ctx.actor?.kind === 'user') watchCard(ctx, cardId, ctx.actor.userId);
}

// ---- what notifies whom (called inside the change's transaction) ----

/** A card moved (done and reopened included): its watchers. */
export function notifyMoved(
  ctx: Ctx,
  cardId: number,
  activityId: number,
  move: { to: string; done?: boolean; reopened?: boolean; blocked?: boolean },
): void {
  const data = { what: 'moved' as const, to: move.to, ...(move.done ? { done: true } : {}), ...(move.reopened ? { reopened: true } : {}), ...(move.blocked ? { blocked: true } : {}) };
  notifyPeople(ctx, { cardId, activityId, type: 'watching', userIds: watchersOf(ctx, cardId), data });
}

/** The assignee changed: the new one is told (and watches from now on), the watchers too. */
export function notifyAssigned(
  ctx: Ctx,
  cardId: number,
  activityId: number,
  change: { to: { id: number; name: string } | null; fromName: string | null },
): void {
  const { to } = change;
  let assigned = new Set<number>();
  if (to) {
    watchCard(ctx, cardId, to.id);
    assigned = told(notifyPeople(ctx, { cardId, activityId, type: 'assigned', userIds: [to.id], data: {} }));
  }
  const took = to !== null && to.id === actorUserId(ctx);
  notifyPeople(ctx, {
    cardId,
    activityId,
    type: 'watching',
    userIds: watchersOf(ctx, cardId).filter((id) => !assigned.has(id)),
    data: { what: 'assigned', toName: to?.name ?? null, fromName: change.fromName, ...(took ? { took: true } : {}) },
  });
}

/** Active people by @username in a note (once each). */
function mentionedPeople(ctx: Ctx, md: string): { id: number; username: string }[] {
  if (!md.includes('@')) return [];
  const active = stmt(ctx.db, 'SELECT id, username FROM users WHERE disabled_at IS NULL').all() as { id: number; username: string }[];
  const byName = new Map(active.map((u) => [u.username.toLowerCase(), u]));
  return findMentions(md, new Set(byName.keys())).map((n) => byName.get(n)!);
}

/**
 * A new note: the people it mentions (who watch the card from now on), then the other watchers.
 * The person writing it watches the card too.
 */
export function notifyNoteAdded(ctx: Ctx, cardId: number, entryId: number, md: string): void {
  if (ctx.actor?.kind === 'user') watchCard(ctx, cardId, ctx.actor.userId);
  const mentioned = mentionedPeople(ctx, md).map((u) => u.id);
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

/** An edited note: only the people it didn't mention before. (A retracted note notifies nobody; the caller checks.) */
export function notifyNoteEdited(ctx: Ctx, cardId: number, entryId: number, before: string, after: string): void {
  const earlier = new Set(mentionedPeople(ctx, before).map((u) => u.id));
  const added = mentionedPeople(ctx, after)
    .map((u) => u.id)
    .filter((id) => !earlier.has(id));
  if (!added.length) return;
  for (const id of added) watchCard(ctx, cardId, id);
  notifyPeople(ctx, { cardId, activityId: entryId, type: 'mentioned', userIds: added, data: { excerpt: noteExcerpt(after) } });
}

/** A ticket from outside (submit page, API token) with nobody assigned: everyone who asked to hear about those. */
export function notifyNewUnassigned(ctx: Ctx, cardId: number, activityId: number, via: string | undefined): void {
  const everyone = stmt(ctx.db, 'SELECT id FROM users WHERE disabled_at IS NULL').pluck().all() as number[];
  notifyPeople(ctx, { cardId, activityId, type: 'new_unassigned', userIds: everyone, data: via ? { via } : {} });
}

// ---- the bell ----

interface ItemRow {
  id: number;
  user_id: number;
  card_id: number;
  type: string;
  data: string;
  created_at: string;
  read_at: string | null;
  title: string;
  ticket_no: string | null;
}

/** Notifications about notes that were retracted since don't show (they come back if it's restored). */
const NOT_RETRACTED = 'NOT EXISTS (SELECT 1 FROM activity a WHERE a.id = n.activity_id AND a.retracted_at IS NOT NULL)';
/** Shown in the bell: not turned off there (hidden), not about a retracted note. */
const IN_BELL = `json_extract(n.data, '$.hidden') IS NULL AND ${NOT_RETRACTED}`;

const ITEM_SELECT = `SELECT n.id, n.user_id, n.card_id, n.type, n.data, n.created_at, n.read_at, c.title, c.ticket_no
  FROM notifications n JOIN cards c ON c.id = n.card_id`;

export function toItem(r: ItemRow): NotificationItem {
  let data: NotificationData = {};
  try {
    data = JSON.parse(r.data) as NotificationData;
  } catch {
    /* a broken row still shows, as "Someone changed this" */
  }
  return {
    id: r.id,
    type: r.type as NotificationType,
    cardId: r.card_id,
    ticketNo: r.ticket_no,
    cardTitle: r.title,
    actorName: data.actorName ?? (r.type === 'new_unassigned' ? (data.via ?? null) : null),
    text: notificationText(r.type, data),
    createdAt: r.created_at,
    readAt: r.read_at,
  };
}

export function listNotifications(ctx: Ctx, userId: number, q: NotificationsQuery): NotificationsResponse {
  const rows = stmt(ctx.db, `${ITEM_SELECT} WHERE n.user_id = ? AND n.id > ? AND ${IN_BELL} ORDER BY n.id DESC LIMIT ?`).all(
    userId,
    q.after ?? 0,
    q.limit,
  ) as ItemRow[];
  const counts = stmt(
    ctx.db,
    `SELECT count(*) FILTER (WHERE n.read_at IS NULL) AS unread, coalesce(max(n.id), 0) AS latest
       FROM notifications n WHERE n.user_id = ? AND ${IN_BELL}`,
  ).get(userId) as { unread: number; latest: number };
  return { items: rows.map(toItem), unread: counts.unread, latestId: counts.latest };
}

/** Marks some, a card's (you opened it) or all of your notifications read. Returns how many are still unread. */
export function markNotificationsRead(ctx: Ctx, userId: number, body: MarkNotificationsReadBody): number {
  const now = nowIso(ctx);
  if (body.all) {
    stmt(ctx.db, 'UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now, userId);
  } else if (body.cardId !== undefined) {
    stmt(ctx.db, 'UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND card_id = ?').run(now, userId, body.cardId);
  } else {
    stmt(ctx.db, 'UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (SELECT value FROM json_each(?))').run(
      now,
      userId,
      JSON.stringify(body.ids ?? []),
    );
  }
  return stmt(ctx.db, `SELECT count(*) FROM notifications n WHERE n.user_id = ? AND n.read_at IS NULL AND ${IN_BELL}`).pluck().get(userId) as number;
}

/** Notifications for personal channels: these rows (if they still exist), oldest first, retracted notes left out. */
export function notificationsById(ctx: Ctx, ids: number[]): (NotificationItem & { userId: number })[] {
  const rows = stmt(ctx.db, `${ITEM_SELECT} WHERE n.id IN (SELECT value FROM json_each(?)) AND ${NOT_RETRACTED} ORDER BY n.id`).all(
    JSON.stringify(ids),
  ) as ItemRow[];
  return rows.map((r) => ({ ...toItem(r), userId: r.user_id }));
}

/** Read ones after READ_KEEP_DAYS, any after UNREAD_KEEP_DAYS. Returns how many went. */
export function pruneNotifications(ctx: Ctx): number {
  const now = ctx.clock.now().getTime();
  const readCutoff = new Date(now - READ_KEEP_DAYS * DAY_MS).toISOString();
  const anyCutoff = new Date(now - UNREAD_KEEP_DAYS * DAY_MS).toISOString();
  return stmt(ctx.db, 'DELETE FROM notifications WHERE (read_at IS NOT NULL AND created_at < ?) OR created_at < ?').run(readCutoff, anyCutoff).changes;
}

// ---- your personal settings ----

export function personalNotifySettings(ctx: Ctx, userId: number): PersonalNotifySettings {
  const u = getUser(ctx, userId);
  return {
    discordUserId: u.discord_user_id,
    ntfyTopic: u.ntfy_topic,
    prefs: prefsOf(u.notify_prefs),
    install: installChannels(ctx),
  };
}

/** Whether the install has the channels personal notifications ride on. */
export function installChannels(ctx: Ctx): { discord: boolean; ntfy: boolean } {
  return { discord: getDiscordSettings(ctx).webhookUrl !== null, ntfy: channelReady('ntfy', getChannelSettings(ctx, 'ntfy')) };
}

/** The topic in the install's ntfy address (https://ntfy.sh/belltower-x → belltower-x), or null. */
function installTopic(ctx: Ctx): string | null {
  const url = getChannelSettings(ctx, 'ntfy').url;
  return url ? (new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? null) : null;
}

/**
 * Whether a person's saved topic may be used: it follows the `belltower-` rule and isn't the
 * install's own topic. Checked when saving and again when sending (a restored backup isn't checked).
 */
export function personalTopicOk(ctx: Ctx, topic: string): boolean {
  return NtfyTopic.safeParse(topic).success && topic === topic.trim() && topic !== installTopic(ctx);
}

export function updatePersonalNotify(ctx: Ctx, userId: number, body: PersonalNotifyBody): PersonalNotifySettings {
  getUser(ctx, userId);
  if (body.ntfyTopic !== null && body.ntfyTopic === installTopic(ctx)) {
    throw badRequest('validation', 'That’s the install’s own ntfy topic; pick a topic of your own (Random topic makes one)');
  }
  stmt(ctx.db, 'UPDATE users SET discord_user_id = ?, ntfy_topic = ?, notify_prefs = ? WHERE id = ?').run(
    body.discordUserId,
    body.ntfyTopic,
    JSON.stringify(body.prefs),
    userId,
  );
  return personalNotifySettings(ctx, userId);
}

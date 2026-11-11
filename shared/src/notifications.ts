// Personal notifications (1.5): what can notify a person, where it goes, @mentions in work-log
// notes, and the short line each notification shows. Shared by the server, the browser-only demo
// and the web app, so all three parse mentions and word notifications the same way.

import { z } from 'zod';

/**
 * What can notify a person. `submitted`: a new ticket from the public submit page (not API tokens
 * or monitors). It's the one event that still reaches admins while Teams is off.
 */
export const NOTIFICATION_TYPES = ['assigned', 'mentioned', 'watching', 'new_unassigned', 'submitted'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Where: the bell in the app, a Discord mention in the install's channel, the person's own ntfy topic. */
export const PERSONAL_CHANNELS = ['inApp', 'discord', 'ntfy'] as const;
export type PersonalChannel = (typeof PERSONAL_CHANNELS)[number];

const ChannelPicks = z.object({ inApp: z.boolean(), discord: z.boolean(), ntfy: z.boolean() });
export type ChannelPicks = z.infer<typeof ChannelPicks>;

/** users.notify_prefs: per event, which channels. */
export const NotifyPrefs = z.object({
  assigned: ChannelPicks,
  mentioned: ChannelPicks,
  watching: ChannelPicks,
  new_unassigned: ChannelPicks,
  submitted: ChannelPicks,
});
export type NotifyPrefs = z.infer<typeof NotifyPrefs>;

/**
 * A member's defaults: in the app for your own cards; personal channels and new outside tickets
 * are opt-in. Admins also get new submit-page tickets in the app (defaultNotifyPrefs).
 */
export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = {
  assigned: { inApp: true, discord: false, ntfy: false },
  mentioned: { inApp: true, discord: false, ntfy: false },
  watching: { inApp: true, discord: false, ntfy: false },
  new_unassigned: { inApp: false, discord: false, ntfy: false },
  submitted: { inApp: false, discord: false, ntfy: false },
};

/** The defaults for someone with this role: admins hear about new submit-page tickets in the app. */
export function defaultNotifyPrefs(role: 'admin' | 'member'): NotifyPrefs {
  const prefs = Object.fromEntries(NOTIFICATION_TYPES.map((t) => [t, { ...DEFAULT_NOTIFY_PREFS[t] }])) as NotifyPrefs;
  if (role === 'admin') prefs.submitted.inApp = true;
  return prefs;
}

/**
 * Stored prefs with the defaults for the person's role filled in. Anything missing or not a
 * boolean takes the default, so prefs saved by an older version (or `{}`, the column's default),
 * which have no `submitted`, still read correctly.
 */
export function notifyPrefsFrom(raw: unknown, role: 'admin' | 'member' = 'member'): NotifyPrefs {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const defaults = defaultNotifyPrefs(role);
  const out = {} as NotifyPrefs;
  for (const type of NOTIFICATION_TYPES) {
    const saved = src[type] && typeof src[type] === 'object' ? (src[type] as Record<string, unknown>) : {};
    const picks = { ...defaults[type] };
    for (const channel of PERSONAL_CHANNELS) if (typeof saved[channel] === 'boolean') picks[channel] = saved[channel];
    out[type] = picks;
  }
  return out;
}

/**
 * Where a notification of this type goes for someone with these prefs. A submit-page ticket is also
 * a new ticket nobody has: someone who wants `submitted` anywhere is told once, as `submitted`, on
 * every channel either event asks for (so a Discord ping for new unassigned tickets isn't lost).
 * Someone who wants only `new_unassigned` gets that instead (notifyNewUnassigned).
 */
export function picksFor(prefs: NotifyPrefs, type: NotificationType): ChannelPicks {
  const picks = prefs[type];
  if (type !== 'submitted' || (!picks.inApp && !picks.discord && !picks.ntfy)) return picks;
  const also = prefs.new_unassigned;
  return { inApp: picks.inApp || also.inApp, discord: picks.discord || also.discord, ntfy: picks.ntfy || also.ntfy };
}

/** A Discord user ID (a "snowflake"): Developer Mode → right-click yourself → Copy User ID. */
export const DiscordUserId = z.string().trim().regex(/^\d{17,20}$/, 'A Discord user ID is 17 to 20 digits (Copy User ID in Discord)');
/**
 * A personal ntfy topic: `belltower-` and then up to 54 letters, digits, dashes and underscores
 * (ntfy's own rule, 64 in all). The prefix lets an ntfy admin give the install's token write
 * access to `belltower-*` only, so nobody can make Belltower post to any other topic.
 */
export const PERSONAL_TOPIC_PREFIX = 'belltower-';
export const NtfyTopic = z
  .string()
  .trim()
  .regex(/^belltower-[A-Za-z0-9_-]{1,54}$/, 'Start it with belltower-, then up to 54 letters, digits, dashes and underscores');

/**
 * PUT /api/me/notifications. null clears the Discord ID or the topic. `prefs.submitted` may be
 * left out (a tab still on a bundle from before it existed): the saved choice is kept.
 */
export const PersonalNotifyBody = z.object({
  discordUserId: DiscordUserId.nullable(),
  ntfyTopic: NtfyTopic.nullable(),
  prefs: NotifyPrefs.extend({ submitted: ChannelPicks.optional() }),
});
export type PersonalNotifyBody = z.infer<typeof PersonalNotifyBody>;

/** GET /api/notifications: your newest first; `after` returns only newer ones (by id). */
export const NotificationsQuery = z.object({
  after: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type NotificationsQuery = z.infer<typeof NotificationsQuery>;

/** POST /api/notifications/read: these, the ones about a card (you opened it), or all of them. */
export const MarkNotificationsReadBody = z
  .object({
    ids: z.array(z.number().int().positive()).max(500).optional(),
    cardId: z.number().int().positive().optional(),
    all: z.boolean().optional(),
  })
  .refine((b) => b.all === true || b.cardId !== undefined || (b.ids?.length ?? 0) > 0, 'Send ids, a cardId, or all: true');
export type MarkNotificationsReadBody = z.infer<typeof MarkNotificationsReadBody>;

// ---- @mentions ----

/**
 * Usernames are 2–32 of a-z 0-9 . _ - (case-insensitive). A mention is an @ that doesn't follow a
 * letter, digit, backslash or one of . _ + - / @, so "sam@example.com", URLs and an escaped \@sam
 * aren't mentions, and isn't followed by another @ ("@sam@host" is someone elsewhere).
 */
export const MENTION_RE = /(?<![\p{L}\p{N}._+\-/@\\])@([A-Za-z0-9._-]{2,32})(?![A-Za-z0-9._@-])/gu;

/** A list item's first line ("- x", "* x", "1. x", "2) x"). */
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

/**
 * Indented code blocks: lines indented four spaces (or a tab) that start after a blank line, as
 * markdown-it reads them. Inside a list such lines continue the item instead (they're text), so
 * after a list item they're left alone.
 */
function withoutIndentedCode(md: string): string {
  const out: string[] = [];
  let inCode = false;
  let afterBlank = true;
  let inList = false;
  for (const line of md.split('\n')) {
    const blank = line.trim() === '';
    const indented = /^(?: {4}|\t)/.test(line);
    if (inCode && (blank || indented)) {
      out.push('');
      continue;
    }
    inCode = false;
    if (!blank && indented && afterBlank && !inList) {
      inCode = true;
      out.push('');
      continue;
    }
    if (!blank && !indented) inList = LIST_ITEM.test(line);
    afterBlank = blank;
    out.push(line);
  }
  return out.join('\n');
}

/** Code (fenced blocks, indented blocks, inline spans), where an @ is just text. */
function withoutCode(md: string): string {
  // Fenced blocks (``` or ~~~, closed or running to the end of the note).
  const unfenced = md.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[`~]*[ \t]*$|(?![\s\S]))/gm, '');
  // Inline code: a run of backticks up to the same run, within one paragraph.
  return withoutIndentedCode(unfenced).replace(/(`+)(?:(?!\n[ \t]*\n)[\s\S])*?\1/g, '');
}

/**
 * The usernames @mentioned in a work-log note, lower-cased and once each, in order. Mentions in
 * code and email addresses don't count. A trailing dot, dash or underscore ("thanks @sam.") is
 * dropped when the name without it is a known one; pass `known` (lower-case usernames) for that.
 */
export function findMentions(md: string, known?: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const m of withoutCode(md).matchAll(MENTION_RE)) {
    const name = resolveMention(m[1]!, known);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** "sam." → "sam" when only that is known; null when `known` is given and neither is in it. */
export function resolveMention(raw: string, known?: ReadonlySet<string>): string | null {
  const full = raw.toLowerCase();
  const trimmed = full.replace(/[._-]+$/, '');
  if (!known) return trimmed.length >= 2 ? trimmed : null;
  if (known.has(full)) return full;
  return trimmed.length >= 2 && known.has(trimmed) ? trimmed : null;
}

// ---- what a notification says ----

/** notifications.data. Names are copied in, as in the activity log, so renames don't rewrite it. */
export interface NotificationData {
  /** Who did it, as it read at the time. */
  actorName?: string | null;
  /** Turned off in the bell (only personal channels carry it). */
  hidden?: boolean;
  /** mentioned, and watching a note: the note's start. */
  excerpt?: string;
  /** new_unassigned and submitted: where it came from ("submit page (Sam)"). */
  via?: string;
  /** watching: what changed. */
  what?: 'note' | 'moved' | 'assigned';
  /** moved: the column it's in now, and whether that finished, reopened or parked it (blocked). */
  to?: string;
  done?: boolean;
  reopened?: boolean;
  blocked?: boolean;
  /** assigned: to and from whom (null = nobody), and whether the person acting took it. */
  toName?: string | null;
  fromName?: string | null;
  took?: boolean;
}

/** A note's start, for notifications ("Swapped the SATA cable…"). */
export function noteExcerpt(md: string, max = 120): string {
  const t = md.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * What happened, as one sentence that starts with who did it ("Alex mentioned you: “…”"). The
 * card's ticket number and title are shown next to it, so they aren't repeated here.
 */
export function notificationText(type: NotificationType | string, data: NotificationData): string {
  const who = data.actorName || 'Someone';
  switch (type) {
    case 'assigned':
      return `${who} assigned this to you`;
    case 'mentioned':
      return data.excerpt ? `${who} mentioned you: “${data.excerpt}”` : `${who} mentioned you`;
    case 'new_unassigned':
      return data.via ? `New ticket from ${data.via}, not assigned yet` : 'New ticket, not assigned yet';
    case 'submitted':
      return `New ticket from ${data.via || 'the submit page'}`;
    case 'watching':
      switch (data.what) {
        case 'note':
          return `${who} added a note: “${data.excerpt}”`;
        case 'moved':
          if (data.done) return `${who} marked this done`;
          if (data.reopened) return `${who} reopened this (now in ${data.to})`;
          if (data.blocked) return `Moved to ${data.to}: it’s blocked`;
          return `${who} moved this to ${data.to}`;
        case 'assigned':
          if (data.took) return `${who} took this`;
          if (data.toName) return `${who} assigned this to ${data.toName}`;
          return data.fromName ? `${who} unassigned ${data.fromName}` : `${who} unassigned this`;
        default:
          return `${who} changed this`;
      }
    default:
      return `${who} changed this`;
  }
}

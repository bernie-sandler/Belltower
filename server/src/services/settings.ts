// App settings kept in the `settings` table as small JSON documents, with defaults for anything
// not saved yet. Edited on the Settings page (GET/PUT /api/settings…).

import { randomBytes } from 'node:crypto';
import {
  DEFAULT_RESOLUTION_REASONS,
  DEFAULT_TICKET_FORMAT,
  NOTIFY_CHANNELS,
  type DiscordSettingsBody,
  type GeneralSettingsBody,
  type NotifyAlertsBody,
  type NotifyChannel,
  type NotifyChannelBody,
  type NotifyChannelInfo,
  type SettingsResponse,
  type SubmitSettingsBody,
  type TeamsSettingsBody,
} from '@tt/shared';
import { getSetting, setSetting } from '../db/connection';
import { badRequest } from '../errors';
import { getBlockedColumnId } from './columns';
import { nowIso, type Ctx } from './context';

const KEY = {
  general: 'general_settings',
  submit: 'submit_settings',
  discord: 'discord_settings',
  channels: 'notify_channels',
  teams: 'teams_settings',
} as const;

/** Every channel that can send, Discord included. */
export type AnyChannel = 'discord' | NotifyChannel;
/** `discord_last_delivery`, `ntfy_last_delivery`… (Discord's key predates the others). */
const deliveryKey = (channel: AnyChannel) => `${channel}_last_delivery`;
/** The local date the daily summary last went out on this channel. */
export const digestKey = (channel: AnyChannel) => `${channel}_digest_last`;

export interface GeneralSettings {
  ticketFormat: string;
  appUrl: string;
  claudeModel: string;
}

export interface SubmitSettings {
  enabled: boolean;
  columnId: number | null;
  pageTitle: string;
  intro: string;
  /** The secret part of the submit page's address; null until the page is first turned on. */
  key: string | null;
}

export interface DiscordSettings {
  webhookUrl: string | null;
  events: { external: boolean; critical: boolean; digest: boolean; blocked: boolean };
  digestTime: string;
  /** Cards at this priority or higher, or this severity or worse, count as urgent. */
  alertPriority: 'critical' | 'high' | 'medium';
  alertSeverity: 'blocker' | 'major' | 'minor';
}

/**
 * The team features: assignees, Mine and Unassigned, watching, @mentions, the bell and personal
 * notifications. Off by default, so a solo install looks as it did before 1.5. While off, the app
 * hides them and notifyPeople writes only `submitted` (to admins, in the app); nothing is deleted.
 */
export interface TeamsSettings {
  enabled: boolean;
}

export interface Delivery {
  at: string;
  ok: boolean;
  message: string;
}

const GENERAL_DEFAULTS: GeneralSettings = { ticketFormat: DEFAULT_TICKET_FORMAT, appUrl: '', claudeModel: '' };
const SUBMIT_DEFAULTS: SubmitSettings = {
  enabled: false,
  columnId: null,
  pageTitle: 'Report a problem',
  intro: 'Tell us what’s wrong and we’ll take a look.',
  key: null,
};
const TEAMS_DEFAULTS: TeamsSettings = { enabled: false };
const DISCORD_DEFAULTS: DiscordSettings = {
  webhookUrl: null,
  events: { external: true, critical: true, digest: false, blocked: false },
  digestTime: '08:00',
  alertPriority: 'high',
  alertSeverity: 'blocker',
};

function read<T extends object>(ctx: Ctx, key: string, defaults: T): T {
  const raw = getSetting(ctx.db, key);
  if (!raw) return { ...defaults };
  try {
    return { ...defaults, ...(JSON.parse(raw) as Partial<T>) };
  } catch {
    return { ...defaults };
  }
}

function write(ctx: Ctx, key: string, value: object): void {
  setSetting(ctx.db, key, JSON.stringify(value));
}

export const getGeneralSettings = (ctx: Ctx) => read(ctx, KEY.general, GENERAL_DEFAULTS);
export const getSubmitSettings = (ctx: Ctx) => read(ctx, KEY.submit, SUBMIT_DEFAULTS);
export const getDiscordSettings = (ctx: Ctx) => {
  const d = read(ctx, KEY.discord, DISCORD_DEFAULTS);
  return { ...d, events: { ...DISCORD_DEFAULTS.events, ...d.events } };
};

/** A restored backup isn't validated, so anything but `true` reads as off. */
export const getTeamsSettings = (ctx: Ctx): TeamsSettings => ({ enabled: read(ctx, KEY.teams, TEAMS_DEFAULTS).enabled === true });
export const teamsEnabled = (ctx: Ctx): boolean => getTeamsSettings(ctx).enabled;

export function updateTeamsSettings(ctx: Ctx, body: TeamsSettingsBody): void {
  write(ctx, KEY.teams, { enabled: body.enabled });
}

export function updateGeneralSettings(ctx: Ctx, body: GeneralSettingsBody): void {
  write(ctx, KEY.general, { ...getGeneralSettings(ctx), ...body });
}

export function updateSubmitSettings(ctx: Ctx, body: SubmitSettingsBody): void {
  if (body.columnId !== null && !ctx.db.prepare('SELECT 1 FROM columns WHERE id = ?').get(body.columnId)) {
    throw badRequest('invalid_target', 'That column no longer exists');
  }
  const current = getSubmitSettings(ctx);
  // The page gets its address the first time it's turned on.
  const key = current.key ?? (body.enabled ? newSubmitKey() : null);
  write(ctx, KEY.submit, { ...current, ...body, key });
}

/** A new address for the submit page; the old link stops working at once. */
export function regenerateSubmitKey(ctx: Ctx): string {
  const key = newSubmitKey();
  write(ctx, KEY.submit, { ...getSubmitSettings(ctx), key });
  return key;
}

function newSubmitKey(): string {
  return randomBytes(24).toString('base64url');
}

/** The summary time and alert levels left out keep their saved values. */
export function updateDiscordSettings(ctx: Ctx, body: DiscordSettingsBody): void {
  const current = getDiscordSettings(ctx);
  const webhookUrl = body.webhookUrl === null ? current.webhookUrl : body.webhookUrl || null;
  write(ctx, KEY.discord, {
    webhookUrl,
    events: body.events,
    digestTime: body.digestTime ?? current.digestTime,
    alertPriority: body.alertPriority ?? current.alertPriority,
    alertSeverity: body.alertSeverity ?? current.alertSeverity,
  });
}

// ---- every channel: alert levels, daily summary time ----

export type AlertSettings = Pick<DiscordSettings, 'digestTime' | 'alertPriority' | 'alertSeverity'>;

/**
 * What counts as urgent and when the daily summary goes out, for every channel. Kept in
 * discord_settings, where they lived before there were other channels, so nothing moves.
 */
export function getAlertSettings(ctx: Ctx): AlertSettings {
  const { digestTime, alertPriority, alertSeverity } = getDiscordSettings(ctx);
  return { digestTime, alertPriority, alertSeverity };
}

export function updateAlertSettings(ctx: Ctx, body: NotifyAlertsBody): void {
  write(ctx, KEY.discord, { ...read(ctx, KEY.discord, DISCORD_DEFAULTS), ...body });
}

// ---- ntfy, Gotify, webhook ----

export type ChannelEvents = DiscordSettings['events'];

export interface ChannelSettings {
  /** ntfy: the topic's address. Gotify: the server's address. Webhook: where to POST. */
  url: string | null;
  /** ntfy access token, Gotify app token, or the webhook's signing secret. */
  secret: string | null;
  events: ChannelEvents;
}

const CHANNEL_DEFAULTS: ChannelSettings = { url: null, secret: null, events: { ...DISCORD_DEFAULTS.events } };

/** ntfy topics: letters, digits, - and _ (ntfy's own rule). */
const NTFY_TOPIC = /^[-\w]{1,64}$/;

/** A saved address that still parses as http(s), or null. A restored backup isn't validated, so this is checked on every read. */
function usableUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function getChannelSettings(ctx: Ctx, channel: NotifyChannel): ChannelSettings {
  const all = read<Partial<Record<NotifyChannel, Partial<ChannelSettings>>>>(ctx, KEY.channels, {});
  const c = all[channel] ?? {};
  return {
    url: usableUrl(c.url),
    secret: typeof c.secret === 'string' && c.secret ? c.secret : null,
    events: { ...CHANNEL_DEFAULTS.events, ...c.events },
  };
}

/** Whether a channel has what it needs to send. Gotify can't post without its app token. */
export function channelReady(channel: AnyChannel, s: { url: string | null; secret?: string | null }): boolean {
  return s.url !== null && (channel !== 'gotify' || Boolean(s.secret));
}

function checkChannelUrl(channel: NotifyChannel, raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw badRequest('validation', 'That address isn’t valid');
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) {
    throw badRequest('validation', 'Enter an http:// or https:// address (without a user name or password in it)');
  }
  if (channel === 'ntfy' && !NTFY_TOPIC.test(u.pathname.split('/').filter(Boolean).at(-1) ?? '')) {
    throw badRequest('validation', 'Paste the topic’s address, like https://ntfy.sh/my-topic');
  }
  return u;
}

/** Tokens go into a request header, so they must be plain printable characters (ntfy's and Gotify's are). */
const HEADER_SAFE = /^[\x21-\x7e]+$/;

/**
 * Saves a channel. `url`/`secret`: null keeps the saved value, '' removes it. Pointing the channel
 * at another origin (scheme, host or port: https → http counts) forgets the saved secret unless a
 * new one comes with it, so a token can't be sent somewhere else, or in the clear, by changing only
 * the address. A secret saved before any address is kept when the address is first set.
 */
export function updateChannelSettings(ctx: Ctx, channel: NotifyChannel, body: NotifyChannelBody): void {
  const current = getChannelSettings(ctx, channel);
  const url = body.url === null ? current.url : body.url ? checkChannelUrl(channel, body.url).toString() : null;
  if (body.secret && channel !== 'webhook' && !HEADER_SAFE.test(body.secret)) {
    throw badRequest('validation', 'Tokens can only contain letters, digits and plain punctuation (no spaces)');
  }
  let secret = body.secret === null ? current.secret : body.secret || null;
  const originOf = (u: string | null) => (u ? new URL(u).origin : null);
  if (body.secret === null && current.url !== null && originOf(url) !== originOf(current.url)) secret = null;
  const all = read<Partial<Record<NotifyChannel, ChannelSettings>>>(ctx, KEY.channels, {});
  write(ctx, KEY.channels, { ...all, [channel]: { url, secret, events: body.events } });
}

/**
 * "https://ntfy.sh/…": the scheme and host, never the path or query (an ntfy topic works like a
 * password, and a query may hold a token). Gotify's path holds nothing secret, so it's shown.
 */
function channelHint(channel: NotifyChannel, url: string | null): string | null {
  if (!url) return null;
  const u = new URL(url); // getChannelSettings only returns addresses that parse
  if (channel === 'gotify') return `${u.origin}${u.pathname.replace(/\/$/, '')}${u.search ? '?…' : ''}`;
  return u.pathname === '/' && !u.search ? u.origin : `${u.origin}/…`;
}

function channelInfo(ctx: Ctx, channel: NotifyChannel): NotifyChannelInfo {
  const c = getChannelSettings(ctx, channel);
  return {
    set: channelReady(channel, c),
    hint: channelHint(channel, c.url),
    secretSet: c.secret !== null,
    events: c.events,
    lastDelivery: lastDelivery(ctx, channel),
  };
}

/** Resolution reasons in order; the first is the default ("Fixed"). */
export function getResolutionReasons(ctx: Ctx): string[] {
  const raw = getSetting(ctx.db, 'resolution_reasons');
  try {
    const list = raw ? (JSON.parse(raw) as unknown) : null;
    if (Array.isArray(list) && list.length && list.every((x) => typeof x === 'string')) return list as string[];
  } catch {
    /* fall through to the defaults */
  }
  return [...DEFAULT_RESOLUTION_REASONS];
}

export function setResolutionReasons(ctx: Ctx, reasons: string[]): void {
  setSetting(ctx.db, 'resolution_reasons', JSON.stringify(reasons));
}

export function recordDelivery(ctx: Ctx, channel: AnyChannel, ok: boolean, message: string): void {
  write(ctx, deliveryKey(channel), { at: nowIso(ctx), ok, message: message.slice(0, 300) });
}

export function lastDelivery(ctx: Ctx, channel: AnyChannel = 'discord'): Delivery | null {
  const raw = getSetting(ctx.db, deliveryKey(channel));
  try {
    return raw ? (JSON.parse(raw) as Delivery) : null;
  } catch {
    return null;
  }
}

/** "https://discord.com/api/webhooks/1234…/abcd…" — enough to recognise it, not enough to use it. */
function webhookHint(url: string | null): string | null {
  const m = url ? /^(https:\/\/[^/]+\/api\/webhooks\/)(\d+)\/([\w-]+)$/.exec(url) : null;
  return m ? `${m[1]}${m[2]!.slice(0, 4)}…/${m[3]!.slice(0, 4)}…` : null;
}

export function settingsResponse(ctx: Ctx, ai: { modelFromEnv: string | null; enabled: boolean }): SettingsResponse {
  const general = getGeneralSettings(ctx);
  const submit = getSubmitSettings(ctx);
  const discord = getDiscordSettings(ctx);
  return {
    general: { ...general, claudeModelFromEnv: ai.modelFromEnv, claudeEnabled: ai.enabled },
    submit,
    discord: {
      webhookSet: discord.webhookUrl !== null,
      webhookHint: webhookHint(discord.webhookUrl),
      events: discord.events,
      digestTime: discord.digestTime,
      alertPriority: discord.alertPriority,
      alertSeverity: discord.alertSeverity,
      lastDelivery: lastDelivery(ctx),
    },
    notify: {
      alerts: getAlertSettings(ctx),
      channels: Object.fromEntries(NOTIFY_CHANNELS.map((c) => [c, channelInfo(ctx, c)])) as Record<NotifyChannel, NotifyChannelInfo>,
    },
    blockedColumnId: getBlockedColumnId(ctx),
    resolutionReasons: getResolutionReasons(ctx),
    teams: getTeamsSettings(ctx),
  };
}

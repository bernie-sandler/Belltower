// App settings kept in the `settings` table as small JSON documents, with defaults for anything
// not saved yet. Edited on the Settings page (GET/PUT /api/settings…).

import { randomBytes } from 'node:crypto';
import {
  DEFAULT_TICKET_FORMAT,
  type DiscordSettingsBody,
  type GeneralSettingsBody,
  type SettingsResponse,
  type SubmitSettingsBody,
} from '@tt/shared';
import { getSetting, setSetting } from '../db/connection';
import { badRequest } from '../errors';
import { getBlockedColumnId } from './columns';
import { nowIso, type Ctx } from './context';

const KEY = {
  general: 'general_settings',
  submit: 'submit_settings',
  discord: 'discord_settings',
  delivery: 'discord_last_delivery',
} as const;

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

/** Alert levels left out keep their saved value. */
export function updateDiscordSettings(
  ctx: Ctx,
  body: Omit<DiscordSettingsBody, 'alertPriority' | 'alertSeverity'> & Partial<Pick<DiscordSettingsBody, 'alertPriority' | 'alertSeverity'>>,
): void {
  const current = getDiscordSettings(ctx);
  const webhookUrl = body.webhookUrl === null ? current.webhookUrl : body.webhookUrl || null;
  write(ctx, KEY.discord, {
    webhookUrl,
    events: body.events,
    digestTime: body.digestTime,
    alertPriority: body.alertPriority ?? current.alertPriority,
    alertSeverity: body.alertSeverity ?? current.alertSeverity,
  });
}

export function recordDelivery(ctx: Ctx, ok: boolean, message: string): void {
  write(ctx, KEY.delivery, { at: nowIso(ctx), ok, message: message.slice(0, 300) });
}

export function lastDelivery(ctx: Ctx): Delivery | null {
  const raw = getSetting(ctx.db, KEY.delivery);
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
    blockedColumnId: getBlockedColumnId(ctx),
  };
}

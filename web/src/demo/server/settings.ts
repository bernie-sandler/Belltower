// Mirrors server/src/services/settings.ts and requestTypes.ts.

import {
  DEFAULT_RESOLUTION_REASONS,
  type DiscordSettingsBody,
  type GeneralSettingsBody,
  NOTIFY_CHANNELS,
  type NotifyAlertsBody,
  type NotifyChannel,
  type NotifyChannelBody,
  type RequestType,
  type RequestTypeBody,
  type SettingsResponse,
  type SubmitSettingsBody,
  type TeamsSettingsBody,
} from '@tt/shared';
import { getBlockedColumnId } from './columns';
import { byPosition, nextId, nowIso, type Ctx, type RequestTypeRow } from './db';
import { badRequest, notFound } from './errors';

export function getResolutionReasons(ctx: Ctx): string[] {
  const list = ctx.s.settings.resolutionReasons;
  return list?.length ? [...list] : [...DEFAULT_RESOLUTION_REASONS];
}

export function setResolutionReasons(ctx: Ctx, reasons: string[]): void {
  ctx.s.settings.resolutionReasons = [...reasons];
}

/**
 * Teams (off by default on a real install). The demo seeds it on; data saved before the setting
 * existed showed the team features, so it reads as on too.
 */
export const teamsEnabled = (ctx: Ctx): boolean => ctx.s.settings.teams?.enabled !== false;

export function updateTeamsSettings(ctx: Ctx, body: TeamsSettingsBody): void {
  ctx.s.settings.teams = { enabled: body.enabled };
}

export function updateGeneralSettings(ctx: Ctx, body: GeneralSettingsBody): void {
  ctx.s.settings.general = { ...ctx.s.settings.general, ...body };
}

/** The secret part of the submit page's address (24 random bytes, base64url, like the server). */
export function newSubmitKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function updateSubmitSettings(ctx: Ctx, body: SubmitSettingsBody): void {
  if (body.columnId !== null && !ctx.s.columns.some((c) => c.id === body.columnId)) {
    throw badRequest('invalid_target', 'That column no longer exists');
  }
  const current = ctx.s.settings.submit;
  const key = current.key ?? (body.enabled ? newSubmitKey() : null);
  ctx.s.settings.submit = { ...current, ...body, key };
}

export function regenerateSubmitKey(ctx: Ctx): string {
  const key = newSubmitKey();
  ctx.s.settings.submit = { ...ctx.s.settings.submit, key };
  return key;
}

export function updateDiscordSettings(ctx: Ctx, body: DiscordSettingsBody): void {
  const current = ctx.s.settings.discord;
  ctx.s.settings.discord = {
    webhookUrl: body.webhookUrl === null ? current.webhookUrl : body.webhookUrl || null,
    events: body.events,
    digestTime: body.digestTime ?? current.digestTime,
    alertPriority: body.alertPriority ?? current.alertPriority,
    alertSeverity: body.alertSeverity ?? current.alertSeverity,
  };
}

/** Like the server: the shared levels live with Discord's settings. */
export function updateAlertSettings(ctx: Ctx, body: NotifyAlertsBody): void {
  ctx.s.settings.discord = { ...ctx.s.settings.discord, ...body };
}

const CHANNEL_EVENTS = { external: true, critical: true, digest: false, blocked: false };

/** The demo can't send, so only a channel's event choices are kept (the route refuses addresses). */
export function updateChannelEvents(ctx: Ctx, channel: NotifyChannel, body: NotifyChannelBody): void {
  ctx.s.settings.notifyChannels = { ...ctx.s.settings.notifyChannels, [channel]: { events: body.events } };
}

export function settingsResponse(ctx: Ctx): SettingsResponse {
  const { general, submit, discord } = ctx.s.settings;
  return {
    // No ANTHROPIC_API_KEY in the browser: Claude drafting is always off in the demo.
    general: { ...general, claudeModelFromEnv: null, claudeEnabled: false },
    submit: { ...submit },
    discord: {
      webhookSet: discord.webhookUrl !== null,
      webhookHint: null,
      events: { ...discord.events },
      digestTime: discord.digestTime,
      alertPriority: discord.alertPriority,
      alertSeverity: discord.alertSeverity,
      lastDelivery: null,
    },
    notify: {
      alerts: { digestTime: discord.digestTime, alertPriority: discord.alertPriority, alertSeverity: discord.alertSeverity },
      channels: Object.fromEntries(
        NOTIFY_CHANNELS.map((c) => [
          c,
          { set: false, hint: null, secretSet: false, events: { ...(ctx.s.settings.notifyChannels?.[c]?.events ?? CHANNEL_EVENTS) }, lastDelivery: null },
        ]),
      ) as SettingsResponse['notify']['channels'],
    },
    blockedColumnId: getBlockedColumnId(ctx),
    resolutionReasons: getResolutionReasons(ctx),
    teams: { enabled: teamsEnabled(ctx) },
  };
}

// ---- request types ----

function toType(ctx: Ctx, r: RequestTypeRow): RequestType {
  const labels = new Set(ctx.s.labels.map((l) => l.id));
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    titlePattern: r.titlePattern,
    fields: structuredClone(r.fields),
    tagLabelIds: r.tagLabelIds.filter((id) => labels.has(id)),
    typeLabelId: r.typeLabelId,
    position: r.position,
    enabled: r.enabled,
  };
}

export function listRequestTypes(ctx: Ctx): RequestType[] {
  return [...ctx.s.requestTypes].sort(byPosition).map((r) => toType(ctx, r));
}

function typeRow(ctx: Ctx, id: number): RequestTypeRow {
  const row = ctx.s.requestTypes.find((t) => t.id === id);
  if (!row) throw notFound('Request type not found');
  return row;
}

function checkLabels(ctx: Ctx, body: RequestTypeBody): void {
  for (const id of [...body.tagLabelIds, ...(body.typeLabelId !== null ? [body.typeLabelId] : [])]) {
    if (!ctx.s.labels.some((l) => l.id === id)) throw badRequest('validation', `Unknown label id ${id}`);
  }
}

export function createRequestType(ctx: Ctx, body: RequestTypeBody): RequestType {
  checkLabels(ctx, body);
  const now = nowIso(ctx);
  const row: RequestTypeRow = {
    id: nextId(ctx, 'requestTypes'),
    name: body.name,
    description: body.description,
    titlePattern: body.titlePattern,
    fields: body.fields,
    tagLabelIds: [...new Set(body.tagLabelIds)],
    typeLabelId: body.typeLabelId,
    position: Math.max(-1, ...ctx.s.requestTypes.map((t) => t.position)) + 1,
    enabled: body.enabled,
    createdAt: now,
    updatedAt: now,
  };
  ctx.s.requestTypes.push(row);
  return toType(ctx, row);
}

export function updateRequestType(ctx: Ctx, id: number, body: RequestTypeBody): RequestType {
  const row = typeRow(ctx, id);
  checkLabels(ctx, body);
  Object.assign(row, {
    name: body.name,
    description: body.description,
    titlePattern: body.titlePattern,
    fields: body.fields,
    tagLabelIds: [...new Set(body.tagLabelIds)],
    typeLabelId: body.typeLabelId,
    enabled: body.enabled,
    updatedAt: nowIso(ctx),
  });
  return toType(ctx, row);
}

export function deleteRequestType(ctx: Ctx, id: number): void {
  typeRow(ctx, id);
  ctx.s.requestTypes = ctx.s.requestTypes.filter((t) => t.id !== id);
}

export function reorderRequestTypes(ctx: Ctx, ids: number[]): RequestType[] {
  const existing = ctx.s.requestTypes.map((t) => t.id);
  if (ids.length !== existing.length || new Set(ids).size !== ids.length || !ids.every((id) => existing.includes(id))) {
    throw badRequest('validation', 'ids must list every request type exactly once');
  }
  ids.forEach((id, i) => (typeRow(ctx, id).position = i));
  return listRequestTypes(ctx);
}

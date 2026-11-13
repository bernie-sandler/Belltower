// The demo's "database": one plain object, kept in localStorage by ../store.ts. The row shapes
// follow the real tables in server/src/db/schema.ts (camelCase, with card_labels folded into
// CardRow.labelIds), so the services next to this file can follow server/src/services closely.

import type {
  CardKind,
  CardSource,
  ChecklistItemState,
  ColumnRole,
  NotifyChannel,
  Priority,
  RequestFieldDef,
  Severity,
  TemplateChecklist,
  UserRole,
} from '@tt/shared';

/**
 * Bump this whenever DemoState changes shape. Saved data with another version is thrown away and
 * the demo seeds itself again, instead of crashing on data it doesn't understand.
 * 3: people (1.5): users, assignees, watchers, notifications, and who did what.
 * 4: request types carry the labels every ticket gets (labelIds), submitters no longer pick tags.
 */
export const DEMO_SCHEMA_VERSION = 4;

/** The users table (no passwords: the demo signs anyone in as the owner). */
export interface UserRow {
  id: number;
  username: string;
  displayName: string;
  email: string | null;
  role: UserRole;
  isOwner: boolean;
  /** Mirrors password_hash IS NOT NULL. */
  hasPassword: boolean;
  discordUserId: string | null;
  ntfyTopic: string | null;
  notifyPrefs: Record<string, unknown>;
  createdAt: string;
  disabledAt: string | null;
}

export interface WatcherRow {
  cardId: number;
  userId: number;
  createdAt: string;
}

export interface NotificationRow {
  id: number;
  userId: number;
  cardId: number;
  activityId: number | null;
  type: string;
  actorUserId: number | null;
  data: Record<string, unknown>;
  createdAt: string;
  readAt: string | null;
}

export interface ColumnRow {
  id: number;
  name: string;
  position: number;
  role: ColumnRole | null;
  createdAt: string;
}

export interface LabelRow {
  id: number;
  name: string;
  color: string;
  position: number;
  createdAt: string;
}

export interface CardRow {
  id: number;
  columnId: number;
  title: string;
  descriptionMd: string;
  priority: Priority | null;
  severity: Severity | null;
  dueDate: string | null;
  dueTime: string | null;
  position: number;
  version: number;
  completedAt: string | null;
  archivedAt: string | null;
  deletedAt: string | null;
  source: CardSource;
  sourceRef: string | null;
  templateId: number | null;
  ticketNo: string | null;
  kind: CardKind;
  parentId: number | null;
  resolution: string | null;
  resolutionMd: string;
  /** Who it's assigned to (1.5). */
  assigneeId: number | null;
  createdAt: string;
  updatedAt: string;
  /** card_labels, in the order they were added (read through labelIdsOf for label order). */
  labelIds: number[];
}

export interface ChecklistRow {
  id: number;
  cardId: number;
  title: string;
  position: number;
  createdAt: string;
}

export interface ChecklistItemRow {
  id: number;
  checklistId: number;
  text: string;
  /** The API's `checked` is derived: true only when this is 'done'. */
  state: ChecklistItemState;
  /** When the current mark was set; null while open. */
  checkedAt: string | null;
  position: number;
  createdAt: string;
}

export interface LinkRow {
  id: number;
  fromCardId: number;
  toCardId: number;
  type: 'relates' | 'blocks';
  createdAt: string;
}

export interface ActivityRow {
  id: number;
  cardId: number;
  kind: 'event' | 'worklog';
  type: string;
  data: Record<string, unknown>;
  bodyMd: string | null;
  occurredAt: string;
  createdAt: string;
  editedAt: string | null;
  retractedAt: string | null;
  /** Who did it (a token's owner for a token); null for the submit page, templates and the seed's system steps. */
  userId: number | null;
  tokenId: number | null;
}

export interface RevisionRow {
  id: number;
  activityId: number;
  bodyMd: string;
  occurredAt: string;
  revisedAt: string;
  userId: number | null;
}

export interface TemplateRow {
  id: number;
  title: string;
  descriptionMd: string;
  priority: Priority | null;
  checklists: TemplateChecklist[];
  intervalUnit: 'day' | 'week' | 'month';
  intervalCount: number;
  startDate: string;
  nextRunDate: string;
  dueInDays: number | null;
  enabled: boolean;
  labelIds: number[];
  createdAt: string;
  updatedAt: string;
}

export interface TemplateRunRow {
  id: number;
  templateId: number;
  occurrenceDate: string | null;
  outcome: 'created' | 'skipped_open' | 'manual';
  cardId: number | null;
  ranAt: string;
}

export interface RequestTypeRow {
  id: number;
  name: string;
  description: string;
  titlePattern: string;
  fields: RequestFieldDef[];
  /** request_type_labels: the labels every ticket of this type gets (read through labelIdsOf). */
  labelIds: number[];
  position: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DemoSettings {
  general: { ticketFormat: string; appUrl: string; claudeModel: string };
  submit: { enabled: boolean; columnId: number | null; pageTitle: string; intro: string; key: string | null };
  discord: {
    webhookUrl: string | null;
    events: { external: boolean; critical: boolean; digest: boolean; blocked: boolean };
    digestTime: string;
    alertPriority: 'critical' | 'high' | 'medium';
    alertSeverity: 'blocker' | 'major' | 'minor';
  };
  /** Like the server's blocked_column_id setting: null = not chosen yet, 'none' = turned off. */
  blockedColumn: number | 'none' | null;
  /** null = the defaults. */
  resolutionReasons: string[] | null;
  /** ntfy, Gotify, webhook: only their event choices (the demo can't send). Optional for older saved data. */
  notifyChannels?: Partial<Record<NotifyChannel, { events: { external: boolean; critical: boolean; digest: boolean; blocked: boolean } }>>;
  /** Signs ticket status links (status.ts). Optional, so data saved before it existed still loads. */
  statusSecret?: string | null;
  /**
   * Settings → General → Teams. The demo seeds it on, so visitors see the team features; data
   * saved before it existed (which showed them) has none, and reads as on (settings.ts).
   */
  teams?: { enabled: boolean };
}

export type TableName =
  | 'columns'
  | 'labels'
  | 'cards'
  | 'checklists'
  | 'checklistItems'
  | 'links'
  | 'activity'
  | 'revisions'
  | 'templates'
  | 'templateRuns'
  | 'requestTypes'
  | 'users'
  | 'notifications';

export interface DemoState {
  version: number;
  /** When this copy of the demo data was seeded. */
  seededAt: string;
  /** The next id per table (ids are never reused, like SQLite's AUTOINCREMENT). */
  ids: Record<TableName, number>;
  columns: ColumnRow[];
  labels: LabelRow[];
  cards: CardRow[];
  checklists: ChecklistRow[];
  checklistItems: ChecklistItemRow[];
  links: LinkRow[];
  activity: ActivityRow[];
  revisions: RevisionRow[];
  templates: TemplateRow[];
  templateRuns: TemplateRunRow[];
  requestTypes: RequestTypeRow[];
  users: UserRow[];
  watchers: WatcherRow[];
  notifications: NotificationRow[];
  settings: DemoSettings;
  /** The demo's stand-in for a session cookie: signed in, as whom (the owner). */
  session: { signedIn: boolean; userId: number | null };
}

/**
 * What every service gets: the state to read and change, the app time zone, the clock, and who is
 * acting (like the server's ctx.actor; absent or null means the system or the public).
 */
export interface Ctx {
  s: DemoState;
  tz: string;
  now(): Date;
  userId?: number | null;
}

/** The person acting, or null. */
export const actorId = (ctx: Ctx): number | null => ctx.userId ?? null;

export const nowIso = (ctx: Ctx) => ctx.now().toISOString();

export function nextId(ctx: Ctx, table: TableName): number {
  return ctx.s.ids[table]++;
}

export function emptyState(seededAt: string): DemoState {
  const ids = {} as Record<TableName, number>;
  for (const t of [
    'columns',
    'labels',
    'cards',
    'checklists',
    'checklistItems',
    'links',
    'activity',
    'revisions',
    'templates',
    'templateRuns',
    'requestTypes',
    'users',
    'notifications',
  ] as TableName[]) {
    ids[t] = 1;
  }
  return {
    version: DEMO_SCHEMA_VERSION,
    seededAt,
    ids,
    columns: [],
    labels: [],
    cards: [],
    checklists: [],
    checklistItems: [],
    links: [],
    activity: [],
    revisions: [],
    templates: [],
    templateRuns: [],
    requestTypes: [],
    users: [],
    watchers: [],
    notifications: [],
    settings: {
      general: { ticketFormat: '{YY}{MM}{DD}-{N}', appUrl: '', claudeModel: '' },
      submit: {
        enabled: false,
        columnId: null,
        pageTitle: 'Report a problem',
        intro: 'Tell us what’s wrong and we’ll take a look.',
        key: null,
      },
      discord: {
        webhookUrl: null,
        events: { external: true, critical: true, digest: false, blocked: false },
        digestTime: '08:00',
        alertPriority: 'high',
        alertSeverity: 'blocker',
      },
      blockedColumn: null,
      resolutionReasons: null,
    },
    session: { signedIn: true, userId: null },
  };
}

/** Sort helper for "ORDER BY position, id". */
export const byPosition = <T extends { position: number; id: number }>(a: T, b: T) => a.position - b.position || a.id - b.id;

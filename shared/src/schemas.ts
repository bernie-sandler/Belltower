import { z } from 'zod';
import { CARD_KINDS, LIMITS, PASSWORD_MIN_LENGTH, PRIORITIES, REQUEST_FIELD_KINDS, SEVERITIES } from './constants';

const id = z.number().int().positive();

function isRealDate(s: string): boolean {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** A calendar date in the app time zone, 'YYYY-MM-DD'. */
export const LocalDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine(isRealDate, 'Not a real calendar date');

/** A wall-clock time in the app time zone, 'HH:MM' (24h). */
export const LocalTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM');

/** SQLite's length() stops at NUL, so a NUL would slip past validation and fail a DB CHECK. */
const noNul = (s: string) => !s.includes('\u0000');
const NUL_MESSAGE = 'Contains an invalid (NUL) character';

export const Title = z.string().trim().min(1).max(LIMITS.cardTitle).refine(noNul, NUL_MESSAGE);
export const Description = z.string().max(LIMITS.description);

/** A UTC instant as produced by Date#toISOString(). */
export const IsoInstant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'Expected an ISO timestamp')
  .refine((s) => !Number.isNaN(Date.parse(s)), 'Not a real timestamp');

// ---- auth ----
export const LoginBody = z.object({
  password: z.string().min(1).max(1024),
  remember: z.boolean().default(false),
});
export type LoginBody = z.infer<typeof LoginBody>;

export const SetupBody = z.object({
  setupCode: z.string().trim().min(1).max(64),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(1024),
});
export type SetupBody = z.infer<typeof SetupBody>;

export const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(1024),
});
export type ChangePasswordBody = z.infer<typeof ChangePasswordBody>;

// ---- columns / labels ----
export const ColumnNameBody = z.object({
  name: z.string().trim().min(1).max(LIMITS.columnName).refine(noNul, NUL_MESSAGE),
});
export type ColumnNameBody = z.infer<typeof ColumnNameBody>;

/** Full ordering: every id of the collection, in the new order. */
export const ReorderBody = z.object({
  ids: z.array(id).min(1),
});
export type ReorderBody = z.infer<typeof ReorderBody>;

export const BlockedColumnBody = z.object({ columnId: id.nullable() });
export type BlockedColumnBody = z.infer<typeof BlockedColumnBody>;

export const DeleteColumnQuery = z.object({
  targetColumnId: z.coerce.number().int().positive().optional(),
});
export type DeleteColumnQuery = z.infer<typeof DeleteColumnQuery>;

const LabelColor = z.string().regex(/^#[0-9a-f]{6}$/, 'Expected lowercase #rrggbb');

export const LabelBody = z.object({
  name: z.string().trim().min(1).max(LIMITS.labelName).refine(noNul, NUL_MESSAGE),
  color: LabelColor,
});
export type LabelBody = z.infer<typeof LabelBody>;

export const UpdateLabelBody = LabelBody.partial();
export type UpdateLabelBody = z.infer<typeof UpdateLabelBody>;

// ---- cards ----
export const CreateCardBody = z.object({
  title: Title,
  description: Description.optional(),
  /** Defaults to the Triage-role column. */
  columnId: id.optional(),
  labelIds: z.array(id).max(50).optional(),
  priority: z.enum(PRIORITIES).nullable().optional(),
  severity: z.enum(SEVERITIES).nullable().optional(),
  dueDate: LocalDate.nullable().optional(),
  dueTime: LocalTime.nullable().optional(),
  /** Where in the column the card goes. Default 'bottom'. */
  position: z.enum(['top', 'bottom']).optional(),
  /** Default 'ticket'. */
  kind: z.enum(CARD_KINDS).optional(),
  /** The work card this ticket is part of. */
  parentId: id.nullable().optional(),
});
export type CreateCardBody = z.infer<typeof CreateCardBody>;

export const UpdateCardBody = z.object({
  /** The `version` the client last saw; a mismatch returns 409 version_conflict. */
  expectedVersion: z.number().int().nonnegative(),
  title: Title.optional(),
  description: Description.optional(),
  labelIds: z.array(id).max(50).optional(),
  priority: z.enum(PRIORITIES).nullable().optional(),
  severity: z.enum(SEVERITIES).nullable().optional(),
  dueDate: LocalDate.nullable().optional(),
  dueTime: LocalTime.nullable().optional(),
  /** Backdate (or correct) when a card in Done was completed. Not allowed in the future. */
  completedAt: IsoInstant.optional(),
  kind: z.enum(CARD_KINDS).optional(),
  /** File the ticket under a work card (null takes it out). */
  parentId: id.nullable().optional(),
  /** Set or change how a done card was resolved (null clears it). */
  resolution: z
    .object({
      reason: z.string().trim().min(1).max(40).refine(noNul, NUL_MESSAGE),
      note: z.string().max(LIMITS.description).refine(noNul, NUL_MESSAGE).default(''),
    })
    .nullable()
    .optional(),
});
export type UpdateCardBody = z.infer<typeof UpdateCardBody>;

export const MoveCardBody = z.object({
  toColumnId: id,
  /** Place the card directly after this (visible) card; null = top of the column. */
  afterCardId: id.nullable(),
});
export type MoveCardBody = z.infer<typeof MoveCardBody>;

/** Several cards moved as one block (a folder's tickets), in this order. */
export const MoveCardsBody = z
  .object({
    cardIds: z
      .array(id)
      .min(1)
      .refine((ids) => new Set(ids).size === ids.length, 'List each card once'),
    toColumnId: id,
    /** Place the first card directly after this (visible) card; null = top of the column. */
    afterCardId: id.nullable(),
  })
  .refine((b) => b.afterCardId === null || !b.cardIds.includes(b.afterCardId), {
    message: "The anchor can't be one of the cards being moved",
    path: ['afterCardId'],
  });
export type MoveCardsBody = z.infer<typeof MoveCardsBody>;

// ---- checklists ----
const ChecklistTitle = z.string().trim().min(1).max(LIMITS.checklistTitle).refine(noNul, NUL_MESSAGE);
const ItemText = z.string().trim().min(1).max(LIMITS.checklistItem).refine(noNul, NUL_MESSAGE);

export const ChecklistBody = z.object({ title: ChecklistTitle });
export type ChecklistBody = z.infer<typeof ChecklistBody>;

export const ChecklistItemBody = z.object({ text: ItemText });
export type ChecklistItemBody = z.infer<typeof ChecklistItemBody>;

export const UpdateChecklistItemBody = z.object({
  text: ItemText.optional(),
  checked: z.boolean().optional(),
});
export type UpdateChecklistItemBody = z.infer<typeof UpdateChecklistItemBody>;

// ---- links ----
export const CreateLinkBody = z.object({
  otherCardId: id,
  /** From this card's point of view. */
  direction: z.enum(['relates', 'blocks', 'blocked_by']),
});
export type CreateLinkBody = z.infer<typeof CreateLinkBody>;

/** GET /api/cards: card lists for the link picker, Archive and Trash. */
export const CardListQuery = z.object({
  status: z.enum(['board', 'archived', 'trashed', 'live']).default('live'),
  kind: z.enum(CARD_KINDS).optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type CardListQuery = z.infer<typeof CardListQuery>;

/** How a card was resolved: a reason from Settings' list and an optional Markdown note. */
export const ResolutionBody = z.object({
  reason: z.string().trim().min(1).max(40).refine(noNul, NUL_MESSAGE),
  note: z.string().max(LIMITS.description).refine(noNul, NUL_MESSAGE).default(''),
});
export type ResolutionBody = z.infer<typeof ResolutionBody>;

/** Mark done, optionally together with the open tickets filed under a work card, and how it was resolved. */
export const CompleteCardBody = z.object({
  includeChildren: z.boolean().default(false),
  resolution: ResolutionBody.optional(),
});

export const ResolutionReasonsBody = z.object({
  reasons: z
    .array(z.string().trim().min(1).max(40).refine(noNul, NUL_MESSAGE))
    .min(1)
    .max(12)
    .refine((r) => new Set(r.map((x) => x.toLowerCase())).size === r.length, 'Each reason only once'),
});
export type ResolutionReasonsBody = z.infer<typeof ResolutionReasonsBody>;
export type CompleteCardBody = z.infer<typeof CompleteCardBody>;

// ---- work log ----
export const WorklogBody = z.object({
  bodyMd: z.string().trim().min(1).max(LIMITS.worklog).refine(noNul, NUL_MESSAGE),
  /** When the work happened; defaults to now. Can't be in the future. */
  occurredAt: IsoInstant.optional(),
});
export type WorklogBody = z.infer<typeof WorklogBody>;

export const UpdateWorklogBody = z.object({
  bodyMd: z.string().trim().min(1).max(LIMITS.worklog).refine(noNul, NUL_MESSAGE).optional(),
  occurredAt: IsoInstant.optional(),
  retracted: z.boolean().optional(),
});
export type UpdateWorklogBody = z.infer<typeof UpdateWorklogBody>;

export const TextPreviewQuery = z.object({
  mode: z.enum(['head', 'tail', 'full']).default('head'),
});
export type TextPreviewQuery = z.infer<typeof TextPreviewQuery>;

// ---- Phase 3 ----

const idList = z
  .string()
  .optional()
  .transform((s) => (s ? s.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0) : []));

const enumList = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',') : []))
    .pipe(z.array(z.enum([...values, 'none'] as unknown as [string, ...string[]])));

/** GET /api/search. Lists are comma-separated; 'none' matches cards without a priority/severity. */
export const SearchQuery = z.object({
  q: z.string().trim().max(500).default(''),
  labelIds: idList,
  columnIds: idList,
  priorities: enumList(PRIORITIES),
  severities: enumList(SEVERITIES),
  /** 'all' (default) includes archived cards; Trash is never searched. */
  status: z.enum(['all', 'board', 'archived']).default('all'),
  /** Local dates: cards with any activity (including work logged) in this range. */
  from: LocalDate.optional(),
  to: LocalDate.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

export const CalendarQuery = z
  .object({ from: LocalDate, to: LocalDate })
  .refine((v) => v.from <= v.to, 'from must not be after to');
export type CalendarQuery = z.infer<typeof CalendarQuery>;

const TemplateChecklistSchema = z.object({
  title: z.string().trim().min(1).max(LIMITS.checklistTitle),
  items: z.array(z.string().trim().min(1).max(LIMITS.checklistItem)).max(100),
});

export const TemplateBody = z.object({
  title: Title,
  description: Description.default(''),
  priority: z.enum(PRIORITIES).nullable().default(null),
  labelIds: z.array(id).max(50).default([]),
  checklists: z.array(TemplateChecklistSchema).max(20).default([]),
  intervalUnit: z.enum(['day', 'week', 'month']),
  intervalCount: z.number().int().min(1).max(1000),
  startDate: LocalDate,
  dueInDays: z.number().int().min(0).max(3650).nullable().default(null),
  enabled: z.boolean().default(true),
});
export type TemplateBody = z.infer<typeof TemplateBody>;

// Spelled out (not TemplateBody.partial()) so omitted fields stay undefined instead of taking the
// create-time defaults.
export const UpdateTemplateBody = z.object({
  title: Title.optional(),
  description: Description.optional(),
  priority: z.enum(PRIORITIES).nullable().optional(),
  labelIds: z.array(id).max(50).optional(),
  checklists: z.array(TemplateChecklistSchema).max(20).optional(),
  intervalUnit: z.enum(['day', 'week', 'month']).optional(),
  intervalCount: z.number().int().min(1).max(1000).optional(),
  startDate: LocalDate.optional(),
  dueInDays: z.number().int().min(0).max(3650).nullable().optional(),
  enabled: z.boolean().optional(),
});
export type UpdateTemplateBody = z.infer<typeof UpdateTemplateBody>;

// ---- Phase 4 ----

/** POST /api/import/cards. */
export const CardImportBody = z.object({
  /** The pasted text (JSON, possibly inside ``` fences), or `data` already parsed. */
  text: z.string().max(2_000_000).optional(),
  data: z.unknown().optional(),
  dryRun: z.boolean().default(true),
});
export type CardImportBody = z.infer<typeof CardImportBody>;

// ---- Add ticket (Claude drafting) ----
export const DraftTicketBody = z.object({
  /** The problem in your own words. */
  text: z.string().trim().min(1).max(LIMITS.draftText).refine(noNul, NUL_MESSAGE),
});
export type DraftTicketBody = z.infer<typeof DraftTicketBody>;

/** A card from the Add ticket form: CreateCardBody plus one checklist, links and where it came from. */
export const CreateTicketBody = CreateCardBody.extend({
  checklist: z.array(ItemText).max(50).optional(),
  /** Links to existing cards, from this card's point of view (e.g. ones Claude suggested). */
  links: z
    .array(z.object({ direction: z.enum(['relates', 'blocks', 'blocked_by']), cardId: id }))
    .max(20)
    .optional(),
  /** True when the fields started as a Claude draft (recorded in the card's history). */
  aiDrafted: z.boolean().optional(),
});
export type CreateTicketBody = z.infer<typeof CreateTicketBody>;

// ---- 0.9: settings, submit page, automation ----

/** A question on the submit page. `key` names it in the title pattern, e.g. "Plex – {title} – {summary}". */
export const RequestField = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,29}$/, 'Use lowercase letters, digits and _ (start with a letter)'),
    label: z.string().trim().min(1).max(LIMITS.requestFieldLabel).refine(noNul, NUL_MESSAGE),
    help: z.string().trim().max(200).default(''),
    kind: z.enum(REQUEST_FIELD_KINDS),
    required: z.boolean().default(false),
    options: z.array(z.string().trim().min(1).max(80)).max(LIMITS.requestChoices).default([]),
  })
  .superRefine((f, c) => {
    if ((f.kind === 'choice' || f.kind === 'multi') && f.options.length < 2) {
      c.addIssue({ code: 'custom', path: ['options'], message: 'Give at least two choices' });
    }
    if (f.key === 'summary' || f.key === 'description') {
      c.addIssue({ code: 'custom', path: ['key'], message: `"${f.key}" is built in` });
    }
  });
export type RequestField = z.infer<typeof RequestField>;

export const RequestTypeBody = z
  .object({
    name: z.string().trim().min(1).max(LIMITS.requestTypeName).refine(noNul, NUL_MESSAGE),
    description: z.string().trim().max(300).default(''),
    titlePattern: z.string().trim().min(1).max(200).default('{summary}'),
    fields: z.array(RequestField).max(LIMITS.requestFields).default([]),
    /** Labels submitters may pick as tags. */
    tagLabelIds: z.array(id).max(30).default([]),
    /** A label every ticket of this type gets (optional). */
    typeLabelId: id.nullable().default(null),
    enabled: z.boolean().default(true),
  })
  .superRefine((t, c) => {
    const keys = t.fields.map((f) => f.key);
    keys.forEach((k, i) => {
      if (keys.indexOf(k) !== i) c.addIssue({ code: 'custom', path: ['fields', i, 'key'], message: `Duplicate key "${k}"` });
    });
    for (const m of t.titlePattern.matchAll(/\{([a-z0-9_]+)\}/g)) {
      if (m[1] !== 'summary' && !keys.includes(m[1]!)) {
        c.addIssue({ code: 'custom', path: ['titlePattern'], message: `{${m[1]}} isn't one of this type's question keys` });
      }
    }
  });
export type RequestTypeBody = z.infer<typeof RequestTypeBody>;
export const UpdateRequestTypeBody = RequestTypeBody;

export const GeneralSettingsBody = z.object({
  /** Tokens {YY} {YYYY} {MM} {DD} and {N} (the per-day counter, last). */
  ticketFormat: z
    .string()
    .trim()
    .max(40)
    .refine((s) => /\{N\}$/.test(s) && s.split('{N}').length === 2, 'Must end with {N}, once')
    .refine((s) => !/[%_]/.test(s.replace(/\{(YYYY|YY|MM|DD|N)\}/g, '')), "Can't contain % or _")
    .refine((s) => /^[A-Za-z0-9 \-./#{}]*$/.test(s), 'Use letters, digits, spaces and - . / #'),
  /** The address this app is reached at, for links in notifications. */
  appUrl: z
    .string()
    .trim()
    .max(200)
    .refine((s) => s === '' || /^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(s), 'Start with http:// or https://')
    .transform((s) => s.replace(/\/+$/, '')),
  /** Overrides ANTHROPIC_MODEL ('' = use that). */
  claudeModel: z.string().trim().max(80).regex(/^[a-z0-9.\-]*$/, 'A model id like claude-opus-5-5'),
});
export type GeneralSettingsBody = z.infer<typeof GeneralSettingsBody>;

export const SubmitSettingsBody = z.object({
  enabled: z.boolean(),
  /** Where submitted tickets land; null = Triage. */
  columnId: id.nullable(),
  pageTitle: z.string().trim().min(1).max(80),
  intro: z.string().trim().max(1000),
});
export type SubmitSettingsBody = z.infer<typeof SubmitSettingsBody>;

export const NOTIFY_EVENTS = ['external', 'critical', 'digest', 'blocked'] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

/** Discord webhook URLs only (so the server can't be pointed at arbitrary addresses). */
const DISCORD_WEBHOOK = /^https:\/\/(?:ptb\.|canary\.)?(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/;

export const DiscordSettingsBody = z.object({
  /** null = keep the saved one; '' = remove it. */
  webhookUrl: z
    .string()
    .trim()
    .refine((s) => s === '' || DISCORD_WEBHOOK.test(s), 'Paste a Discord webhook URL (https://discord.com/api/webhooks/…)')
    .nullable(),
  events: z.object({ external: z.boolean(), critical: z.boolean(), digest: z.boolean(), blocked: z.boolean() }),
  /**
   * The alert levels and summary time are shared by every channel (PUT /api/settings/notify). Left
   * out here, they keep their saved values; older clients still send them.
   */
  digestTime: LocalTime.optional(),
  /** "Urgent" means this priority or higher… */
  alertPriority: z.enum(['critical', 'high', 'medium']).optional(),
  /** …or this severity or worse. */
  alertSeverity: z.enum(['blocker', 'major', 'minor']).optional(),
});
export type DiscordSettingsBody = z.infer<typeof DiscordSettingsBody>;

/** Notification channels besides Discord. */
export const NOTIFY_CHANNELS = ['ntfy', 'gotify', 'webhook'] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

const ChannelEvents = z.object({ external: z.boolean(), critical: z.boolean(), digest: z.boolean(), blocked: z.boolean() });

/** PUT /api/settings/notify: what counts as urgent, and when the daily summary goes out (every channel). */
export const NotifyAlertsBody = z.object({
  digestTime: LocalTime,
  alertPriority: z.enum(['critical', 'high', 'medium']),
  alertSeverity: z.enum(['blocker', 'major', 'minor']),
});
export type NotifyAlertsBody = z.infer<typeof NotifyAlertsBody>;

/** An http(s) address with no user name or password in it (the server parses it properly). */
const HTTP_URL = /^https?:\/\/[^\s/?#@]+(?:[/?#]\S*)?$/i;
const ChannelUrl = z
  .string()
  .trim()
  .max(500)
  .refine((s) => s === '' || HTTP_URL.test(s), 'Enter an http:// or https:// address (without a user name or password in it)');

/**
 * PUT /api/settings/notify/{ntfy|gotify|webhook}. `url` and `secret`: null keeps the saved value,
 * '' removes it. The secret is ntfy's access token, Gotify's app token or the webhook's signing
 * secret. Changing the address to another host clears a saved secret unless a new one is sent.
 */
export const NotifyChannelBody = z.object({
  url: ChannelUrl.nullable(),
  secret: z.string().trim().max(500).refine(noNul, NUL_MESSAGE).nullable(),
  events: ChannelEvents,
});
export type NotifyChannelBody = z.infer<typeof NotifyChannelBody>;

/** 'full': everything in /api/v1. 'read': GET only (dashboards); never completes tickets. */
export const TOKEN_SCOPES = ['full', 'read'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

export const ApiTokenBody = z.object({
  name: z.string().trim().min(1).max(60).refine(noNul, NUL_MESSAGE),
  /** Lets "event": "resolved" mark the matching ticket done. Ignored for read-only tokens. */
  canComplete: z.boolean().default(false),
  scope: z.enum(TOKEN_SCOPES).default('full'),
});
export type ApiTokenBody = z.infer<typeof ApiTokenBody>;

/** What the submit page sends (the "data" part of the multipart form). */
export const SubmitBody = z.object({
  typeId: id,
  summary: Title,
  description: z.string().trim().min(1).max(LIMITS.submitAnswer * 2).refine(noNul, NUL_MESSAGE),
  answers: z.record(z.string(), z.union([z.string().max(LIMITS.submitAnswer), z.array(z.string().max(200)).max(LIMITS.requestChoices), z.boolean()])).default({}),
  tagLabelIds: z.array(id).max(30).default([]),
  name: z.string().trim().max(60).refine(noNul, NUL_MESSAGE).default(''),
  /** Honeypot: people never see it, bots fill it in. */
  website: z.string().max(200).optional(),
});
export type SubmitBody = z.infer<typeof SubmitBody>;

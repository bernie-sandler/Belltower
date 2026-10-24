import { z } from 'zod';
import { LIMITS, PASSWORD_MIN_LENGTH, PRIORITIES, SEVERITIES } from './constants';

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
});
export type UpdateCardBody = z.infer<typeof UpdateCardBody>;

export const MoveCardBody = z.object({
  toColumnId: id,
  /** Place the card directly after this (visible) card; null = top of the column. */
  afterCardId: id.nullable(),
});
export type MoveCardBody = z.infer<typeof MoveCardBody>;

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
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type CardListQuery = z.infer<typeof CardListQuery>;

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

// ---- Add ticket (Claude drafting) ----
export const DraftTicketBody = z.object({
  /** The problem in your own words. */
  text: z.string().trim().min(1).max(LIMITS.draftText).refine(noNul, NUL_MESSAGE),
});
export type DraftTicketBody = z.infer<typeof DraftTicketBody>;

/** A card from the Add ticket form: CreateCardBody plus one checklist and where it came from. */
export const CreateTicketBody = CreateCardBody.extend({
  checklist: z.array(ItemText).max(50).optional(),
  /** True when the fields started as a Claude draft (recorded in the card's history). */
  aiDrafted: z.boolean().optional(),
});
export type CreateTicketBody = z.infer<typeof CreateTicketBody>;

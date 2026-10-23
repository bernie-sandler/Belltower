import { z } from 'zod';
import { LIMITS, PASSWORD_MIN_LENGTH, PRIORITIES } from './constants';

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
  dueDate: LocalDate.nullable().optional(),
  dueTime: LocalTime.nullable().optional(),
});
export type UpdateCardBody = z.infer<typeof UpdateCardBody>;

export const MoveCardBody = z.object({
  toColumnId: id,
  /** Place the card directly after this (visible) card; null = top of the column. */
  afterCardId: id.nullable(),
});
export type MoveCardBody = z.infer<typeof MoveCardBody>;

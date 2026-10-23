export const PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_LABELS: Record<Priority, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

export const COLUMN_ROLES = ['triage', 'done'] as const;
export type ColumnRole = (typeof COLUMN_ROLES)[number];

export const CARD_SOURCES = ['manual', 'recurring', 'api'] as const;
export type CardSource = (typeof CARD_SOURCES)[number];

/** Palette offered when creating/editing labels. Hex values are lowercase (the DB enforces that). */
export const LABEL_COLORS = [
  { name: 'Green', hex: '#4bce97' },
  { name: 'Lime', hex: '#94c748' },
  { name: 'Yellow', hex: '#f5cd47' },
  { name: 'Orange', hex: '#fea362' },
  { name: 'Red', hex: '#f87168' },
  { name: 'Pink', hex: '#e774bb' },
  { name: 'Purple', hex: '#9f8fef' },
  { name: 'Blue', hex: '#579dff' },
  { name: 'Sky', hex: '#6cc3e0' },
  { name: 'Gray', hex: '#8590a2' },
] as const;

/** Every mutating /api request must carry this header (CSRF defence). */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'tower-tracker';

export const SESSION_COOKIE = 'tt_sid';
export const PASSWORD_MIN_LENGTH = 12;

export const LIMITS = {
  columnName: 60,
  labelName: 40,
  cardTitle: 300,
  description: 100_000,
} as const;

export const ACTIVITY_EVENT_TYPES = [
  'created',
  'moved',
  'title_changed',
  'description_changed',
  'labels_changed',
  'priority_changed',
  'due_changed',
  'checklist_added',
  'checklist_removed',
  'checklist_item_checked',
  'checklist_item_unchecked',
  'attachment_added',
  'attachment_removed',
  'linked',
  'unlinked',
  'archived',
  'restored',
  'deleted',
  'undeleted',
  'completion_changed',
  'recurrence_skipped',
] as const;
export type ActivityEventType = (typeof ACTIVITY_EVENT_TYPES)[number];
export type ActivityType = ActivityEventType | 'worklog';

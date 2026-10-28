/** Highest first. Stored values stay descriptive; the UI shows P0–P3. */
export const PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_CODES: Record<Priority, string> = { critical: 'P0', high: 'P1', medium: 'P2', low: 'P3' };

export const PRIORITY_LABELS: Record<Priority, string> = {
  critical: 'P0 Critical',
  high: 'P1 High',
  medium: 'P2 Medium',
  low: 'P3 Low',
};

/** Severity: how bad the impact is. Worst first. */
export const SEVERITIES = ['blocker', 'major', 'minor', 'trivial'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY_CODES: Record<Severity, string> = { blocker: 'S1', major: 'S2', minor: 'S3', trivial: 'S4' };

export const SEVERITY_LABELS: Record<Severity, string> = {
  blocker: 'S1 Blocker',
  major: 'S2 Major',
  minor: 'S3 Minor',
  trivial: 'S4 Trivial',
};

export const SEVERITY_DESCRIPTIONS: Record<Severity, string> = {
  blocker: 'Crash, data loss, or the system is unusable',
  major: 'A core function is broken',
  minor: 'Partial breakage or an inconvenience',
  trivial: 'Visual or text issues',
};

export const LEVELS = ['high', 'medium', 'low'] as const;
export type Level = (typeof LEVELS)[number];

/** Priority from impact × urgency: PRIORITY_MATRIX[impact][urgency]. */
export const PRIORITY_MATRIX: Record<Level, Record<Level, Priority>> = {
  high: { high: 'critical', medium: 'high', low: 'medium' },
  medium: { high: 'high', medium: 'medium', low: 'low' },
  low: { high: 'medium', medium: 'low', low: 'low' },
};

export const COLUMN_ROLES = ['triage', 'done'] as const;
export type ColumnRole = (typeof COLUMN_ROLES)[number];

/** A ticket records an issue; a work card is what you're actually working on, and tickets can be filed under it. */
export const CARD_KINDS = ['ticket', 'work'] as const;
export type CardKind = (typeof CARD_KINDS)[number];

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
  checklistTitle: 200,
  checklistItem: 1000,
  /** Add ticket: the problem description sent to Claude. */
  draftText: 8000,
  /** Submit page. */
  requestTypeName: 60,
  requestFieldLabel: 120,
  requestFields: 20,
  requestChoices: 30,
  submitAnswer: 4000,
  submitFiles: 3,
  worklog: 50_000,
  /** Text attachments preview this much (head or tail) before "Load full". */
  textPreviewBytes: 256 * 1024,
  /** "Load full" is refused above this size; download instead. */
  textFullMaxBytes: 5 * 1024 * 1024,
} as const;

/** Extensions shown in the inline text viewer. */
export const TEXT_EXTENSIONS = [
  'log', 'txt', 'conf', 'cfg', 'ini', 'yml', 'yaml', 'json', 'md', 'xml', 'csv', 'toml', 'sh', 'env',
] as const;

export const ACTIVITY_EVENT_TYPES = [
  'created',
  'moved',
  'title_changed',
  'description_changed',
  'labels_changed',
  'priority_changed',
  'severity_changed',
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
  'kind_changed',
  'parent_changed',
  'child_added',
  'child_removed',
  'resolved',
] as const;
export type ActivityEventType = (typeof ACTIVITY_EVENT_TYPES)[number];
export type ActivityType = ActivityEventType | 'worklog';

/** Submit page: the kinds of question a request type can ask. */
export const REQUEST_FIELD_KINDS = ['short', 'long', 'choice', 'multi', 'datetime', 'yesno'] as const;
export type RequestFieldKind = (typeof REQUEST_FIELD_KINDS)[number];

/** Starting list of resolution reasons (editable in Settings). The first is the default. */
export const DEFAULT_RESOLUTION_REASONS = ['Fixed', 'Won’t fix', 'Duplicate', 'Can’t reproduce', 'No longer needed'] as const;

/** Ticket number format tokens; {N} (the per-day counter) must come last. */
export const DEFAULT_TICKET_FORMAT = '{YY}{MM}{DD}-{N}';

import type { ActivityType, CardSource, ColumnRole, Priority, Severity } from './constants';

/** All timestamps are UTC ISO-8601 strings ('2026-10-10T19:04:05.123Z'). */
export type IsoTimestamp = string;
/** 'YYYY-MM-DD' in the app time zone. */
export type LocalDateString = string;

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}

export interface VersionConflictError extends ApiError {
  error: 'version_conflict';
  card: CardDetail;
}

export interface RateLimitedError extends ApiError {
  error: 'rate_limited';
  retryAfterSec: number;
}

export interface AuthStatus {
  authenticated: boolean;
  /** No password exists yet; the UI must show the first-run setup page. */
  setupRequired: boolean;
  /** Password comes from APP_PASSWORD/APP_PASSWORD_FILE; the change-password form is disabled. */
  passwordManagedByEnv: boolean;
}

export interface AppConfig {
  appVersion: string;
  /** IANA zone all dates/times are displayed and entered in, e.g. 'America/Chicago'. */
  timeZone: string;
  maxUploadBytes: number;
  passwordManagedByEnv: boolean;
}

export interface Column {
  id: number;
  name: string;
  position: number;
  /** 'triage' and 'done' columns can be renamed/reordered but not deleted. */
  role: ColumnRole | null;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  position: number;
}

/** What the board needs to draw a tile. */
export interface CardTile {
  id: number;
  columnId: number;
  title: string;
  position: number;
  priority: Priority | null;
  severity: Severity | null;
  dueDate: LocalDateString | null;
  dueTime: string | null;
  completedAt: IsoTimestamp | null;
  labelIds: number[];
  attachmentCount: number;
  linkCount: number;
  checklistDone: number;
  checklistTotal: number;
  version: number;
}

export interface CardDetail extends CardTile {
  description: string;
  archivedAt: IsoTimestamp | null;
  deletedAt: IsoTimestamp | null;
  source: CardSource;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  checklists: Checklist[];
  attachments: Attachment[];
  /** Links to cards that aren't in the Trash, from this card's point of view. */
  links: CardLink[];
}

export interface ChecklistItem {
  id: number;
  text: string;
  checked: boolean;
  checkedAt: IsoTimestamp | null;
  position: number;
}

export interface Checklist {
  id: number;
  title: string;
  position: number;
  items: ChecklistItem[];
}

export type AttachmentKind = 'image' | 'text' | 'file';

export interface Attachment {
  id: number;
  name: string;
  /** Detected on the server from the file's content (images) or extension (text); never the browser's guess. */
  mimeType: string;
  kind: AttachmentKind;
  sizeBytes: number;
  createdAt: IsoTimestamp;
}

/** Text attachment preview: the first or last part of the file. */
export interface TextPreview {
  text: string;
  totalBytes: number;
  truncated: boolean;
  mode: 'head' | 'tail' | 'full';
}

/** 'blocks' = this card blocks the other one; 'blocked_by' = the other one blocks this card. */
export type LinkDirection = 'relates' | 'blocks' | 'blocked_by';

export interface CardLink {
  id: number;
  direction: LinkDirection;
  card: CardSummary;
}

/** A card in a list (link picker, Archive, Trash). */
export interface CardSummary {
  id: number;
  title: string;
  columnId: number;
  columnName: string;
  labelIds: number[];
  completedAt: IsoTimestamp | null;
  archivedAt: IsoTimestamp | null;
  deletedAt: IsoTimestamp | null;
  updatedAt: IsoTimestamp;
}

/** A previous version of an edited work-log entry. */
export interface ActivityRevision {
  id: number;
  bodyMd: string;
  occurredAt: IsoTimestamp;
  /** When this version was replaced. */
  revisedAt: IsoTimestamp;
}

export interface BoardResponse {
  columns: Column[];
  labels: Label[];
  /** Board-visible cards only (not archived, not deleted), ordered by column then position. */
  cards: CardTile[];
}

export interface MoveCardResponse {
  card: CardTile;
  /** Authoritative order (board-visible card ids) for every column the move touched, keyed by column id. */
  orders: Record<string, number[]>;
}

export interface ColumnRef {
  id: number;
  name: string;
  role: ColumnRole | null;
}

export interface LabelRef {
  id: number;
  name: string;
  color: string;
}

/**
 * `data` shapes by type (names are copied in so history survives renames/deletes):
 * - created:             { column: ColumnRef, title, source, templateId?, templateTitle? }
 * - moved:               { from: ColumnRef, to: ColumnRef, reason?: 'column_deleted' }
 * - title_changed:       { from: string, to: string }
 * - description_changed: { from: string, to: string }
 * - labels_changed:      { added: LabelRef[], removed: LabelRef[], reason?: 'label_deleted' }
 * - priority_changed:    { from: Priority|null, to: Priority|null }
 * - severity_changed:    { from: Severity|null, to: Severity|null }
 * - due_changed:         { from: {date,time}|null, to: {date,time}|null }
 * - deleted/undeleted/archived/restored: { column: ColumnRef }
 * - completion_changed:  { from: IsoTimestamp|null, to: IsoTimestamp|null }
 * - checklist_added/removed: { checklistId, title }
 * - checklist_item_checked/unchecked: { checklistId, checklist, itemId, text }
 * - attachment_added/removed: { attachmentId, name, sizeBytes }
 * - linked/unlinked:     { linkId, direction: LinkDirection, otherId, otherTitle }
 * - worklog:             {} (the text is bodyMd; occurredAt may be backdated)
 */
export interface ActivityEntry {
  id: number;
  cardId: number;
  kind: 'event' | 'worklog';
  type: ActivityType;
  data: Record<string, unknown>;
  bodyMd: string | null;
  occurredAt: IsoTimestamp;
  createdAt: IsoTimestamp;
  editedAt: IsoTimestamp | null;
  retractedAt: IsoTimestamp | null;
  /** Number of earlier versions kept for an edited work-log entry. */
  revisionCount: number;
}

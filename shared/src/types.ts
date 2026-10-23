import type { ActivityType, CardSource, ColumnRole, Priority } from './constants';

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
 * - due_changed:         { from: {date,time}|null, to: {date,time}|null }
 * - deleted/undeleted/archived/restored: { column: ColumnRef }
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
}

import type {
  ActivityType,
  CardKind,
  CardSource,
  ChecklistItemState,
  ColumnRole,
  Level,
  Priority,
  RequestFieldKind,
  Severity,
  UserRole,
} from './constants';
import type { NotifyChannel, OidcPreset, PasswordLoginMode, TokenScope } from './schemas';
import type { NotificationType, NotifyPrefs } from './notifications';

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
  /** Single sign-on is set up: the login page offers "Sign in with <label>". Null when it's off. */
  sso: { label: string } | null;
  /**
   * How the login page offers the password form: 'shown', 'hidden' behind a link, or 'off' (only
   * the owner, at /login?password). Always 'shown' while single sign-on is off.
   */
  passwordLogin: PasswordLoginMode;
}

// ---- single sign-on (OIDC) ----

/** GET /api/settings/oidc (admins). The client secret itself is never sent back. */
export interface OidcSettingsInfo {
  enabled: boolean;
  preset: OidcPreset;
  /** '' = the preset's name ("Sign in with Authentik"). */
  buttonLabel: string;
  issuer: string;
  clientId: string;
  /** A secret is saved here or comes from OIDC_CLIENT_SECRET / OIDC_CLIENT_SECRET_FILE. */
  secretSet: boolean;
  /** The environment's secret wins over a saved one; the field is read-only then. */
  secretFromEnv: boolean;
  scopes: string;
  usernameClaim: string;
  groupsClaim: string;
  /** '' = anyone the provider lets through. */
  requiredGroup: string;
  autoCreate: boolean;
  linkByEmail: boolean;
  allowHttpIssuer: boolean;
  /** Password sign-in while single sign-on is on. 'hidden' unless an admin chose otherwise. */
  passwordLogin: PasswordLoginMode;
  /** `${appUrl}/api/auth/oidc/callback`, or null until General → This app’s address is set. */
  redirectUri: string | null;
  /** On, and everything it needs is filled in: the login page shows the button. */
  ready: boolean;
}

/** POST /api/settings/oidc/test: discovery against the issuer. */
export interface OidcTestResult {
  ok: boolean;
  message: string;
  /** The issuer the provider reported (with its exact trailing slash), when it answered. */
  issuer: string | null;
}

// ---- people ----

/** A person as everyone sees them (pickers, mentions, who did what). */
export interface UserRef {
  id: number;
  username: string;
  displayName: string;
  role: UserRole;
  /** Deactivated: can't sign in, their tokens stop working, and they're kept for history. */
  disabled: boolean;
}

/** GET /api/users: the directory. `email` is only filled in for admins and for your own entry. */
export interface UserInfo extends UserRef {
  /** The account that runs the install (APP_PASSWORD manages its password); it can't be demoted or deactivated. */
  isOwner: boolean;
  email: string | null;
  /** False for accounts that sign in only with single sign-on. */
  hasPassword: boolean;
  createdAt: IsoTimestamp;
  disabledAt: IsoTimestamp | null;
}

/** GET /api/me: the signed-in person. */
export interface MeResponse extends UserInfo {
  /** Your password comes from APP_PASSWORD (owner only); it can't be changed in the app. */
  passwordManagedByEnv: boolean;
  /** You can sign in with single sign-on (Account → Sign-in links and unlinks it). */
  ssoLinked: boolean;
}

/**
 * Who did something. Absent on the server means the system (startup, timers, tests). A token acts
 * for the person who made it (`userId`, null for tokens from before 1.5 that nobody owns yet).
 */
export type Actor =
  | { kind: 'user'; userId: number }
  | { kind: 'token'; tokenId: number; userId: number | null }
  | { kind: 'public' }
  | { kind: 'system' };

export interface AppConfig {
  appVersion: string;
  /** IANA zone all dates/times are displayed and entered in, e.g. 'America/Chicago'. */
  timeZone: string;
  maxUploadBytes: number;
  passwordManagedByEnv: boolean;
  /**
   * Settings → General → Teams: assignees, Mine and Unassigned, watching, @mentions and the bell.
   * Off by default; while off the app hides them (nothing is deleted).
   */
  teams: boolean;
  /** Whether the submit page is on. With Teams off, the bell shows (to admins) only while it is. */
  submitPageEnabled: boolean;
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
  /** "YYMMDD-N": local creation date plus a per-day counter, e.g. 261024-1. Shown as "261024-1 — Title". */
  ticketNo: string | null;
  kind: CardKind;
  /** The work card this ticket is part of; null when it has none, or that card is archived or in Trash. */
  parentId: number | null;
  /** Work cards: tickets filed under it (not in Trash), and how many of those are still open. */
  childCount: number;
  childOpen: number;
  /** Done cards: the resolution reason (e.g. "Fixed"), or null when none was given. */
  resolution: string | null;
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
  /** Answered checklist items: done (✓) plus failed (✗). */
  checklistDone: number;
  checklistTotal: number;
  /** Checklist items marked failed (✗). Also counted in checklistDone. */
  checklistFailed: number;
  /** Checklist items marked unverified (~). Not counted in checklistDone. */
  checklistUnverified: number;
  /** Open cards blocking this one (not done, not in Trash); it can't be completed while > 0. */
  blockedBy: number;
  /** The one person this card is assigned to (a user id), or null when nobody has it. */
  assigneeId: number | null;
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
  /** Tickets: the work card it's part of (shown even when archived; null when none or in Trash). */
  parent: CardSummary | null;
  /** Work cards: the tickets filed under it (not in Trash), open ones first. */
  children: CardSummary[];
  /** Markdown note on how it was resolved ('' when none). */
  resolutionNote: string;
  /** You watch this card: new notes, moves and assignee changes notify you. */
  watching: boolean;
}

export interface ChecklistItem {
  id: number;
  text: string;
  state: ChecklistItemState;
  /** True only when state is 'done' (kept for tabs still running an older bundle). */
  checked: boolean;
  /** When the current mark was set; null while open. */
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
  ticketNo: string | null;
  kind: CardKind;
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
  /** Who replaced it (null before 1.5, or when no person did). */
  userId: number | null;
  /** That person's display name and username, for showing who made the edit. */
  userName?: string | null;
  userUsername?: string | null;
}

export interface BoardResponse {
  columns: Column[];
  labels: Label[];
  /** Board-visible cards only (not archived, not deleted), ordered by column then position. */
  cards: CardTile[];
  /** Where cards are moved when they become blocked; null = don't move them. */
  blockedColumnId: number | null;
  /** Resolution reasons offered on Mark done; the first is the default. */
  resolutionReasons: string[];
}

export interface MoveCardResponse {
  card: CardTile;
  /** Authoritative order (board-visible card ids) for every column the move touched, keyed by column id. */
  orders: Record<string, number[]>;
}

export interface MoveCardsResponse {
  /** The moved cards, in the order they were sent. */
  cards: CardTile[];
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
 * - checklist_item_checked/unchecked: { checklistId, checklist, itemId, text } (now done / now open)
 * - checklist_item_marked: { checklistId, checklist, itemId, text, state: 'failed'|'unverified' }
 * - attachment_added/removed: { attachmentId, name, sizeBytes }
 * - linked/unlinked:     { linkId, direction: LinkDirection, otherId, otherTitle }
 * - assigned:            { from: userId|null, to: userId|null, fromName: string|null, toName: string|null }
 *                        (names as they were then; `to` equal to the entry's userId means they took it)
 * - worklog:             {} (the text is bodyMd; occurredAt may be backdated)
 * - worklog_retracted/worklog_restored: { entryId, text } (who retracted or restored a work-log entry)
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
  /**
   * Who did it: the person (for an API token, the token's owner), and the token when one was used.
   * Both null for entries from before 1.5 and for the submit page, recurring templates and startup.
   */
  userId: number | null;
  tokenId: number | null;
  /**
   * Display names for `userId` and `tokenId`, filled in by the server so everyone can read who did
   * what without listing people or tokens. Null when there is no person or token. Display names
   * aren't unique, so `userUsername` (which is) comes along too.
   */
  userName?: string | null;
  userUsername?: string | null;
  tokenName?: string | null;
}

// ---- Phase 3: search, calendar, recurring templates ----

export type SearchField = 'title' | 'description' | 'checklists' | 'worklogs' | 'history';

export interface SearchMatch {
  field: SearchField;
  /** Plain text with \u0002 … \u0003 around each hit; the client turns those into <mark>. */
  snippet: string;
}

export interface SearchResult {
  id: number;
  ticketNo: string | null;
  kind: CardKind;
  title: string;
  columnId: number;
  columnName: string;
  labelIds: number[];
  priority: Priority | null;
  severity: Severity | null;
  completedAt: IsoTimestamp | null;
  archivedAt: IsoTimestamp | null;
  updatedAt: IsoTimestamp;
  matches: SearchMatch[];
}

/** "Seen this before?": a finished ticket that looks like the one at hand, and how it ended. */
export interface SimilarTicket {
  id: number;
  ticketNo: string | null;
  title: string;
  completedAt: IsoTimestamp;
  archived: boolean;
  /** The resolution reason ("Fixed"), if one was recorded. */
  resolution: string | null;
  /** The start of the resolution note as plain text ('' when there's none). */
  note: string;
  /**
   * The work card it was filed under. Tickets finished together with their work card often have no
   * note of their own; the story is on the work card.
   */
  parent: { id: number; ticketNo: string | null; title: string } | null;
}

export type CalendarItemKind = 'due' | 'completed' | 'worklog';

export interface CalendarItem {
  kind: CalendarItemKind;
  /** Local day in the app time zone. */
  date: LocalDateString;
  /** Local 'HH:MM' (due time, completion time, or the work-log's effective time). */
  time: string | null;
  cardId: number;
  ticketNo: string | null;
  title: string;
  priority: Priority | null;
  severity: Severity | null;
  columnName: string;
  completed: boolean;
  archived: boolean;
  /** Work-log entries only. */
  activityId?: number;
  bodyMd?: string;
}

export interface TemplateChecklist {
  title: string;
  items: string[];
}

export interface RecurringTemplate {
  id: number;
  title: string;
  description: string;
  priority: Priority | null;
  labelIds: number[];
  checklists: TemplateChecklist[];
  intervalUnit: 'day' | 'week' | 'month';
  intervalCount: number;
  startDate: LocalDateString;
  /** When the scheduler will next consider creating a card. */
  nextRunDate: LocalDateString;
  /** Generated cards are due this many days after their occurrence date (null = no due date). */
  dueInDays: number | null;
  enabled: boolean;
  /** The open card this template created, if any (no new card is made while it's open). */
  openCardId: number | null;
  lastRun: { at: IsoTimestamp; outcome: 'created' | 'skipped_open' | 'manual'; cardId: number | null } | null;
  /** The next few occurrence dates. */
  upcoming: LocalDateString[];
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface AiStatus {
  /** ANTHROPIC_API_KEY is set, so Add ticket can draft with Claude. */
  enabled: boolean;
  model: string | null;
}

/** Claude's suggestion for a new card; the user reviews and edits it before anything is saved. */
export interface TicketDraft {
  title: string;
  description: string;
  impact: Level;
  urgency: Level;
  /** Always PRIORITY_MATRIX[impact][urgency]. */
  priority: Priority;
  severity: Severity;
  priorityReason: string;
  severityReason: string;
  /** Existing labels only. */
  labelIds: number[];
  checklist: string[];
  dueDate: LocalDateString | null;
  /** Suggested type; 'work' when the text describes a piece of work with several steps. */
  kind: CardKind;
  kindReason: string;
  /** An open work card this ticket belongs under, if one clearly fits. */
  parent: DraftCardRef | null;
  /** Open cards it clearly blocks, waits on, or relates to. */
  links: { direction: LinkDirection; card: DraftCardRef; reason: string }[];
}

export interface DraftCardRef {
  id: number;
  ticketNo: string | null;
  title: string;
}

/** "Describe several issues": the cards Claude wrote (card-import format) and their preview. */
export interface BulkDraft {
  cards: Record<string, unknown>[];
  preview: ImportPreview;
}

/** POST /api/import/cards (and the bulk draft): what would be created, card by card. */
export interface ImportPreview {
  items: ImportPreviewItem[];
  created: number[];
}

export interface ImportPreviewItem {
  index: number;
  /** "2" for a top-level card, "2.1" for a ticket nested under it. */
  label: string;
  ok: boolean;
  errors: string[];
  warnings: string[];
  card: {
    kind: CardKind;
    parent: ImportPreviewRef | null;
    links: { direction: LinkDirection; target: ImportPreviewRef }[];
    title: string;
    description: string;
    column: { id: number; name: string };
    labels: { name: string; existing: boolean }[];
    priority: Priority | null;
    severity: Severity | null;
    dueDate: string | null;
    dueTime: string | null;
    checklists: { title: string; items: string[] }[];
    worklog: { bodyMd: string; occurredAt: string | null }[];
    resolution: { reason: string; note: string } | null;
  } | null;
}

export type ImportPreviewRef = { batchIndex: number; title: string } | { id: number; ticketNo: string | null; title: string };

// ---- 0.9: settings, submit page, automation ----

export interface RequestFieldDef {
  key: string;
  label: string;
  help: string;
  kind: RequestFieldKind;
  required: boolean;
  options: string[];
}

export interface RequestType {
  id: number;
  name: string;
  description: string;
  titlePattern: string;
  fields: RequestFieldDef[];
  /** Labels every ticket of this type gets, in label order. */
  labelIds: number[];
  position: number;
  enabled: boolean;
}

/** What the public submit page gets: enabled types only, and none of your labels. */
export interface PublicSubmitConfig {
  pageTitle: string;
  intro: string;
  types: Omit<RequestType, 'labelIds' | 'position' | 'enabled'>[];
  maxFiles: number;
  maxUploadBytes: number;
}

export interface SubmitResult {
  ticketNo: string | null;
  /** Where the submitter can check on the ticket later ("/submit/status/42/…"); null for the honeypot. */
  statusPath: string | null;
}

/**
 * A ticket's state as people outside see it (the status page). Checked in this order: done, then
 * waiting (blocked column or an open blocker), then received (triage or the submit page's column),
 * else in progress.
 */
export type TicketState = 'received' | 'waiting' | 'in_progress' | 'done';

/** GET /api/public/status/:id/:sig — deliberately little: nothing private from the card. */
export interface PublicTicketStatus {
  ticketNo: string | null;
  title: string;
  submittedAt: IsoTimestamp;
  state: TicketState;
  /** The resolution reason once done ("Fixed"), never the note. */
  resolution: string | null;
  /**
   * When it last moved, was completed or got a different resolution reason. Not every edit, so
   * private notes don't show up.
   */
  changedAt: IsoTimestamp;
}

/** GET /api/cards/:id/status-link. `active` is false while the submit page is off (links answer 404). */
export interface StatusLinkInfo {
  path: string;
  active: boolean;
}

export interface ApiTokenInfo {
  id: number;
  name: string;
  /** First characters, to tell tokens apart ("tt_a1b2…"). */
  prefix: string;
  canComplete: boolean;
  /** 'read' tokens can only call GET routes (the dashboard summary). */
  scope: TokenScope;
  createdAt: IsoTimestamp;
  lastUsedAt: IsoTimestamp | null;
  revokedAt: IsoTimestamp | null;
  /** The person the token acts for. It stops working while they're deactivated. */
  owner: UserRef | null;
}

/**
 * GET /api/v1/summary: ticket counts for dashboards. Part of the frozen v1 contract (docs/API-V1.md):
 * fields may be added, never removed or redefined.
 */
export interface ApiSummary {
  /** Open tickets on the board (not completed, archived or in the Trash) = received + inProgress + waiting. */
  open: number;
  received: number;
  inProgress: number;
  waiting: number;
  /** Open tickets that are urgent under the notification alert levels. */
  urgent: number;
  /** Open cards past their due date / due today: the same cards as the daily summary (work cards included). */
  overdue: number;
  dueToday: number;
  /** Tickets completed since local midnight / in the last 7 local days including today (archived ones too). */
  completedToday: number;
  completed7d: number;
  /** Local days since the oldest open ticket was created, or null when nothing is open. */
  oldestOpenDays: number | null;
  /** Open tickets by priority and severity code. */
  byPriority: { P0: number; P1: number; P2: number; P3: number; none: number };
  bySeverity: { S1: number; S2: number; S3: number; S4: number; none: number };
  generatedAt: IsoTimestamp;
}

export interface SettingsResponse {
  general: { ticketFormat: string; appUrl: string; claudeModel: string; claudeModelFromEnv: string | null; claudeEnabled: boolean };
  submit: { enabled: boolean; columnId: number | null; pageTitle: string; intro: string; key: string | null };
  discord: {
    webhookSet: boolean;
    /** "…/webhooks/1234…/abcd…" with the secret part hidden. */
    webhookHint: string | null;
    events: { external: boolean; critical: boolean; digest: boolean; blocked: boolean };
    digestTime: string;
    alertPriority: 'critical' | 'high' | 'medium';
    alertSeverity: 'blocker' | 'major' | 'minor';
    lastDelivery: { at: IsoTimestamp; ok: boolean; message: string } | null;
  };
  notify: {
    /** Shared by every channel (they also still appear under `discord`). */
    alerts: { digestTime: string; alertPriority: 'critical' | 'high' | 'medium'; alertSeverity: 'blocker' | 'major' | 'minor' };
    channels: Record<NotifyChannel, NotifyChannelInfo>;
  };
  blockedColumnId: number | null;
  resolutionReasons: string[];
  /** The team features (Settings → General → Teams). */
  teams: { enabled: boolean };
}

/** A notification channel as Settings shows it. Saved addresses and secrets are never sent back. */
export interface NotifyChannelInfo {
  /** Ready to send: has an address (and, for Gotify, its app token). */
  set: boolean;
  /** Enough of the address to recognise it, not enough to use it ("https://ntfy.sh/…"). */
  hint: string | null;
  secretSet: boolean;
  events: { external: boolean; critical: boolean; digest: boolean; blocked: boolean };
  lastDelivery: { at: IsoTimestamp; ok: boolean; message: string } | null;
}

// ---- personal notifications (1.5) ----

/** One item in your bell (GET /api/notifications). */
export interface NotificationItem {
  id: number;
  type: NotificationType;
  cardId: number;
  ticketNo: string | null;
  cardTitle: string;
  /** Who did it, as it read at the time ("Alex Chen", "API token “Kuma”"); null for the system. */
  actorName: string | null;
  /** What happened, one sentence ("Alex Chen mentioned you: “…”"). */
  text: string;
  createdAt: IsoTimestamp;
  readAt: IsoTimestamp | null;
}

export interface NotificationsResponse {
  /** Newest first. */
  items: NotificationItem[];
  /** Unread in total (not only among `items`). */
  unread: number;
  /** The newest notification's id (0 when there are none), for `?after=`. */
  latestId: number;
  /**
   * Whether Teams is on (it decides what the list holds). A tab that sees it change starts its
   * "what's new" count over and reloads /api/config, so the switch reaches every open tab.
   */
  teams: boolean;
}

/** GET/PUT /api/me/notifications: your personal channels and what goes where. */
export interface PersonalNotifySettings {
  discordUserId: string | null;
  ntfyTopic: string | null;
  prefs: NotifyPrefs;
  /** Whether the install can carry each personal channel (an admin sets these up in Settings). */
  install: { discord: boolean; ntfy: boolean };
}

/** POST /api/me/notifications/test: what happened on each personal channel you've set up. */
export interface PersonalTestResult {
  discord: { ok: boolean; message: string } | null;
  ntfy: { ok: boolean; message: string } | null;
}

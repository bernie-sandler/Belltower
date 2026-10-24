# Tower Tracker HTTP API

Types and request schemas live in [`shared/src`](../shared/src) (`@tt/shared`). This page lists the routes and
their behavior. Everything is JSON unless noted. Timestamps are UTC ISO strings; `dueDate` is `YYYY-MM-DD` and
`dueTime` is `HH:MM`, both in the app time zone (`AppConfig.timeZone`).

## Conventions

- **Session**: an HttpOnly cookie `tt_sid`. The browser sends it automatically; use `credentials: 'same-origin'`.
- **CSRF**: every non-GET request to `/api/*` **must** send the header `X-Requested-With: tower-tracker`
  (`CSRF_HEADER` / `CSRF_VALUE` in shared). Without it the request gets `403 csrf`.
- **Errors**: always `{ error: string, message: string, details?: unknown }` with a matching HTTP status.
  | Status | `error` codes |
  |---|---|
  | 400 | `validation` (zod issues in `details`), `anchor_not_found`, `target_required`, `invalid_target` (a column in the body no longer exists: refetch), `bad_request` |
  | 401 | `unauthenticated` (no or expired session → show the login page), `invalid_password` |
  | 403 | `csrf`, `invalid_setup_code` |
  | 404 | `not_found`, `setup_not_available` |
  | 409 | `version_conflict` (body also has `card: CardDetail`, the current server copy), `open_instance`, `duplicate_link`, `not_worklog`, `card_deleted` (card is in the Trash), `card_archived` (card is archived), `not_done` (archive needs the Done column), `role_column`, `duplicate_name`, `managed_by_env`, `setup_required`, `password_changed` |
  | 413 | `too_large` |
  | 429 | `rate_limited` (body also has `retryAfterSec`), `busy` |
  | 500 | `internal` |
- **Bodyless requests** (DELETE, logout, undelete, archive, restore) may still send `Content-Type: application/json`;
  the server ignores the header when there is no body.
- **No auth needed** for: `GET /health`, `GET /api/auth/status`, `POST /api/auth/login`, `POST /api/auth/setup`,
  and static files. Everything else returns `401 unauthenticated` without a valid session.

## Auth

| Method & path | Body | Success | Notes |
|---|---|---|---|
| `GET /api/auth/status` | — | `AuthStatus` | Call on app load to choose between the setup page, the login page, or the app. |
| `POST /api/auth/setup` | `SetupBody {setupCode, password}` | `204` + cookie | First run only. The setup code is printed in the container log. `404 setup_not_available` once a password exists. `403 invalid_setup_code`. Password must be at least 12 characters. Logs you in as a remembered device. |
| `POST /api/auth/login` | `LoginBody {password, remember}` | `204` + cookie | `401 invalid_password`, `429 rate_limited {retryAfterSec}`, `409 setup_required`. `remember: true` gives a 90-day sliding cookie; otherwise the cookie lasts for the browser session with a 12-hour idle timeout. |
| `POST /api/auth/logout` | — | `204` | Clears the cookie. |
| `POST /api/auth/password` | `ChangePasswordBody {currentPassword, newPassword}` | `204` | `401 invalid_password`, `409 managed_by_env`. Revokes every other session. |

## Config

| `GET /api/config` | → `AppConfig {appVersion, timeZone, maxUploadBytes, passwordManagedByEnv}` |
|---|---|

## Board

| Method & path | Body | Success |
|---|---|---|
| `GET /api/board` | — | `BoardResponse {columns, labels, cards}` (cards ordered by column, then position; archived and deleted cards excluded) |

## Columns

| Method & path | Body | Success | Notes |
|---|---|---|---|
| `POST /api/columns` | `ColumnNameBody {name}` | `Column` | Appended at the end (right). |
| `PATCH /api/columns/:id` | `ColumnNameBody {name}` | `Column` | Rename. |
| `PUT /api/columns/order` | `ReorderBody {ids}` | `Column[]` | `ids` must contain every column id exactly once, in the new left-to-right order. |
| `DELETE /api/columns/:id?targetColumnId=N` | — | `204` | `409 role_column` for the Triage/Done columns. If the column has any cards (including archived or deleted ones), `targetColumnId` is required (`400 target_required`). All its cards move to the bottom of the target, and each move is logged. |

## Labels

| Method & path | Body | Success | Notes |
|---|---|---|---|
| `POST /api/labels` | `LabelBody {name, color}` | `Label` | `409 duplicate_name` (case-insensitive). `color` is lowercase `#rrggbb`; offer `LABEL_COLORS`. |
| `PATCH /api/labels/:id` | `UpdateLabelBody` | `Label` | |
| `DELETE /api/labels/:id` | — | `204` | Removed from every card (including ones in the Trash); each affected card logs `labels_changed` with `reason: 'label_deleted'`. |
| `PUT /api/labels/order` | `ReorderBody {ids}` | `Label[]` | Every label id exactly once. |

## Cards

| Method & path | Body | Success | Notes |
|---|---|---|---|
| `POST /api/cards` | `CreateCardBody` | `201 CardDetail` | Defaults to the Triage column and `position: 'bottom'`. Logs `created`. |
| `GET /api/cards/:id` | — | `CardDetail` | Also works for archived and deleted cards (check `archivedAt` / `deletedAt`). |
| `PATCH /api/cards/:id` | `UpdateCardBody {expectedVersion, …fields}` | `CardDetail` | Send only the fields that changed. `409 version_conflict` (body includes the current `card`) if the card changed elsewhere; `409 card_deleted` if it is in the Trash. Each changed field logs one event. |
| `POST /api/cards/:id/move` | `MoveCardBody {toColumnId, afterCardId}` | `MoveCardResponse {card, orders}` | `afterCardId: null` puts the card at the top. To put it at the bottom, pass the id of the column's last visible card (if that is the card itself, nothing moves). Anchoring on a card id keeps the move correct while the board is filtered. `400 anchor_not_found` means the client is stale: refetch the board. Moving to another column logs `moved`. Entering the Done column sets `completedAt`; leaving it clears it. Reordering within a column logs nothing. `orders` holds the authoritative order for the affected column(s); apply it to the cache. |
| `DELETE /api/cards/:id` | — | `204` | Soft delete (moves the card to Trash). Logs `deleted`. |
| `POST /api/cards/:id/undelete` | — | `CardDetail` | Restores the card from Trash to the bottom of its column. |
| `POST /api/cards/:id/archive` | — | `CardDetail` | Only allowed for cards in the Done column (`409 not_done`). |
| `POST /api/cards/:id/restore` | — | `CardDetail` | Un-archives the card to the bottom of its column. |
| `GET /api/cards/:id/activity` | — | `ActivityEntry[]` | Newest first. |

## Card parts (Phase 2)

Every route below that changes a card returns the updated `CardDetail`, which now also carries
`checklists`, `attachments` and `links`.

| Method & path | Body | Success | Notes |
|---|---|---|---|
| `GET /api/cards?status=&q=&limit=` | — | `CardSummary[]` | `status`: `live` (default), `board`, `archived` or `trashed`. `q` matches titles, or `#id`. Used by the link picker, Archive and Trash. |
| `POST /api/cards/archive-done` | — | `{archived}` | Archives every card in the Done column. |
| `POST /api/cards/:id/checklists` | `ChecklistBody {title}` | `CardDetail` | Logs `checklist_added`. |
| `PUT /api/cards/:id/checklists/order` | `ReorderBody` | `CardDetail` | |
| `PATCH /api/checklists/:id` | `ChecklistBody` | `CardDetail` | Rename. |
| `DELETE /api/checklists/:id` | — | `CardDetail` | Logs `checklist_removed`. |
| `POST /api/checklists/:id/items` | `ChecklistItemBody {text}` | `CardDetail` | |
| `PUT /api/checklists/:id/items/order` | `ReorderBody` | `CardDetail` | |
| `PATCH /api/checklist-items/:id` | `UpdateChecklistItemBody {text?, checked?}` | `CardDetail` | Checking or unchecking logs an event; text edits don't. |
| `DELETE /api/checklist-items/:id` | — | `CardDetail` | |
| `POST /api/cards/:id/links` | `CreateLinkBody {otherCardId, direction}` | `CardDetail` | `direction` from this card's view: `relates`, `blocks` or `blocked_by`. `409 duplicate_link`. Logged on both cards. |
| `DELETE /api/cards/:id/links/:linkId` | — | `CardDetail` | Logged on both cards. |
| `POST /api/cards/:id/worklog` | `WorklogBody {bodyMd, occurredAt?}` | `201 ActivityEntry` | `occurredAt` backdates the entry; it can't be in the future. |
| `PATCH /api/activity/:id` | `UpdateWorklogBody {bodyMd?, occurredAt?, retracted?}` | `ActivityEntry` | Work-log entries only (`409 not_worklog`). The previous text and time are kept as a revision. |
| `GET /api/activity/:id/revisions` | — | `ActivityRevision[]` | Oldest first; the first one is the original text. |
| `POST /api/cards/:id/attachments` | multipart, one or more `file` fields | `CardDetail` | Up to `MAX_UPLOAD_MB` per file and 10 files per request (`413 too_large`). The kind is detected from the content. |
| `GET /api/attachments/:id` | — | file | Images and text files are served inline, everything else as a download; `?download=1` always downloads. Sent with a sandboxing CSP. |
| `GET /api/attachments/:id/text?mode=head\|tail\|full` | — | `TextPreview` | Text files only (`415 not_text`). Previews 256 KB; `full` is limited to 5 MB. |
| `DELETE /api/attachments/:id` | — | `CardDetail` | Deletes the file; the history keeps its name. |

`PATCH /api/cards/:id` also accepts `completedAt` (an ISO instant) to backdate when a card in Done was completed
(`409 not_done` otherwise; it can't be in the future).

## Phase 3: search, calendar, recurring maintenance

| Method & path | Body | Success | Notes |
|---|---|---|---|
| `GET /api/search?q=&labelIds=&columnIds=&priorities=&severities=&status=&from=&to=&limit=` | — | `SearchResult[]` | Full-text search over titles, descriptions, checklists, work logs and history. Every word must match somewhere on the card (prefix match). Archived cards are included (`status=board` or `archived` narrows it); the Trash never is. Lists are comma-separated; `none` matches cards with no priority/severity. `from`/`to` (local dates) keep cards with any activity in that range. Snippets mark hits with `…`, as plain text. |
| `GET /api/calendar?from=&to=` | — | `CalendarItem[]` | Local dates, inclusive, up to 100 days. Returns cards due, cards completed and work logged, each on its local day. Archived cards count; Trash and retracted work logs don't. |
| `GET /api/templates` | — | `RecurringTemplate[]` | |
| `POST /api/templates` | `TemplateBody` | `201 RecurringTemplate` | Runs the scheduler right away, so a template due today creates its card immediately. |
| `PATCH /api/templates/:id` | `UpdateTemplateBody` | `RecurringTemplate` | Resuming or changing the schedule restarts from today (no catch-up). |
| `DELETE /api/templates/:id` | — | `204` | Cards it created stay. |
| `POST /api/templates/:id/run[?force=1]` | — | `201 CardDetail` | "Create now". `409 open_instance` (body has `cardId`) while a card from it is still open, unless forced. The schedule is unchanged. |
| `POST /api/columns/:id/sort-by-priority` | — | `{orders}` | One-off sort: P0 → P3, then S1 → S4, unrated cards last. |

The scheduler runs at startup and every 10 minutes. On a template's day it creates one card in Triage, or skips (and notes
the date on the open card) if the previous card is still open. After downtime it handles only the latest missed
occurrence.

## Phase 4: backup, restore, card import

| Method & path | Body | Success | Notes |
|---|---|---|---|
| `GET /api/backup/export.json` | — | JSON file | `{format: "tower-tracker-backup", schemaVersion, appVersion, appTz, exportedAt, tables}`. Sessions and the password are excluded. |
| `GET /api/backup/export.zip` | — | ZIP file | `data.json` plus `attachments/<card id>/<uuid>`. |
| `POST /api/backup/restore` | multipart `file` (.zip or .json), up to `MAX_IMPORT_MB` | `RestorePreview` | Builds and checks a new database; nothing live changes. The preview `token` is valid for 30 minutes. |
| `POST /api/backup/restore/:token/confirm` | `{confirm: "RESTORE"}` | `{restored, previousDb}` | Swaps the restored data in. The old database and attachments are kept in `/data/backups`. Password and sessions carry over. |
| `DELETE /api/backup/restore/:token` | — | `204` | Discards a staged restore. |
| `GET /api/backup/snapshots` | — | `{name, sizeBytes, modifiedAt}[]` | Files in `/data/backups`. |
| `POST /api/import/cards` | `{text?: string, data?: any, dryRun?: boolean = true}` | `200` preview / `201` result | See [CARD-IMPORT.md](CARD-IMPORT.md). All-or-nothing; `400` with `result` when any card is invalid. |

## Health

`GET /health` returns `200 {"status":"ok"}`, or `503` if the DB or `/data` is unusable. No auth.

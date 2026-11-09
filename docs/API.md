# Belltower HTTP API (internal)

This is the API the web UI uses. It's documented to help with development, and it may change between versions. For
scripts and monitoring tools, use the stable [automation API](API-V1.md) (`/api/v1/`), which is versioned and won't
break within 1.x.

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
| `PUT /api/board/blocked-column` | `{columnId: number \| null}` | `204` | The column newly blocked cards are moved to (`BoardResponse.blockedColumnId`); `null` turns it off. Triage and Done are refused (`400 invalid_target`). Defaults to the first column named like "Blocked"/"Waiting". |
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
| `POST /api/cards/:id/complete` | `{includeChildren?: boolean = false, resolution?: {reason, note?}}` | `{card, orders, completed}` | Mark done: moves the card (and, with `includeChildren` on a work card, every open ticket filed under it) to the top of Done, and records `resolution` on every card moved. All or nothing: `409 blocked` with `stuck: [{id, ticketNo, title, blockers}]` if any of them is blocked by an open card outside the set. `completed` lists the ids moved. |
| `POST /api/cards/:id/move` | `MoveCardBody {toColumnId, afterCardId}` | `MoveCardResponse {card, orders}` | `afterCardId: null` puts the card at the top. To put it at the bottom, pass the id of the column's last visible card (if that is the card itself, nothing moves). Anchoring on a card id keeps the move correct while the board is filtered. `400 anchor_not_found` means the client is stale: refetch the board. Moving to another column logs `moved`. Entering the Done column sets `completedAt`; leaving it clears it. A card with open blockers (cards that block it and aren't done or in the Trash; `CardTile.blockedBy` counts them) can't enter Done: `409 blocked` with `blockers: [{id, title}]`. Reordering within a column logs nothing. `orders` holds the authoritative order for the affected column(s); apply it to the cache. |
| `POST /api/cards/move-many` | `MoveCardsBody {cardIds, toColumnId, afterCardId}` | `MoveCardsResponse {cards, orders}` | Moves several cards as one block (a folder's tickets): in the order listed, the first directly after `afterCardId` (`null` = top). One transaction, so if any card can't move, none do. `409 card_deleted` and `409 card_archived` name the card in `message`; `409 blocked` with `blockers: [{id, title}]` if a card entering Done has open blockers, even when the blocker is also in the list; `404 not_found`, `400 anchor_not_found` and `400 invalid_target` as for a single move. `400 validation` for a repeated id, or an anchor that is one of the cards. A card that changes column logs `moved`. `orders` holds the final order of every column involved. Web app only: not part of `/api/v1`. |
| `DELETE /api/cards/:id` | — | `204` | Soft delete (moves the card to Trash). Logs `deleted`. |
| `POST /api/cards/:id/undelete` | — | `CardDetail` | Restores the card from Trash to the bottom of its column. |
| `POST /api/cards/:id/archive` | — | `CardDetail` | Only allowed for cards in the Done column (`409 not_done`). |
| `POST /api/cards/:id/restore` | — | `CardDetail` | Un-archives the card to the bottom of its column. |
| `GET /api/cards/:id/activity` | — | `ActivityEntry[]` | Newest first. |
| `GET /api/cards/:id/status-link` | — | `StatusLinkInfo {path, active}` | The ticket's status page path (`/submit/status/<id>/<sig>`). `active` is false while the submit page is off. `409 not_ticket` for work cards, `409 deleted` in the Trash. Creates the signing secret the first time. |

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

Work cards: `CreateCardBody` and `UpdateCardBody` accept `kind` (`'ticket'` default, or `'work'`) and `parentId`
(the work card a ticket is filed under; `null` takes it out). Only a work card can be a parent and only a ticket can
have one (`400 invalid_parent`); a work card that still has tickets can't become a ticket. Tiles carry `kind`,
`parentId` (null while the parent is archived or in the Trash), `childCount` and `childOpen`; `CardDetail` adds
`parent` and `children`. Filing logs `parent_changed` on the ticket and `child_added`/`child_removed` on the work
cards. `GET /api/cards?kind=work` lists only work cards.

`PATCH /api/cards/:id` also accepts `completedAt` (an ISO instant) to backdate when a card in Done was completed
(`409 not_done` otherwise; it can't be in the future).

**Resolutions (0.10).** A done card can say how it was resolved: `CardTile.resolution` (a reason such as "Fixed",
or null) and `CardDetail.resolutionNote` (Markdown, `''` when none). Set them with Mark done
(`POST /api/cards/:id/complete` with `resolution`) or later with `PATCH /api/cards/:id`
`{resolution: {reason, note} | null}` (`409 not_done` unless the card is done). Leaving Done clears them. Each
change logs `resolved` `{reason, note, from}`. The reasons offered are in `BoardResponse.resolutionReasons` and
`SettingsResponse.resolutionReasons` (first = default); any reason up to 40 characters is accepted, so renaming one
in Settings doesn't touch history. The note is included in search.

## Phase 3: search, calendar, recurring maintenance

| Method & path | Body | Success | Notes |
|---|---|---|---|
| `GET /api/search?q=&labelIds=&columnIds=&priorities=&severities=&status=&from=&to=&limit=` | — | `SearchResult[]` | Full-text search over titles, descriptions, checklists, work logs and history. Every word must match somewhere on the card (prefix match). Archived cards are included (`status=board` or `archived` narrows it); the Trash never is. Lists are comma-separated; `none` matches cards with no priority/severity. `from`/`to` (local dates) keep cards with any activity in that range. Snippets mark hits with `…`, as plain text. |
| `GET /api/cards/:id/similar` | — | `SimilarTicket[]` | "Seen this before?": up to 5 finished tickets like this one, best first, each with `resolution`, `note` (plain text, up to 300 characters), `archived` and `parent` (its work card). Only titles and descriptions are compared, not resolutions. At least two distinctive words must match (one, if the ticket has only one), plus at least one word of this ticket's title. Work cards, cards in the Trash, the card itself and cards already linked to it are left out, and work cards get `[]`. |
| `GET /api/similar?title=&description=` | — | `SimilarTicket[]` | The same for a ticket that hasn't been created yet (Add ticket). `title` up to 300 characters, `description` up to 4000 (only the first 500 are used; the web app sends 600). |
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

## Add ticket (Claude drafting)

| Method & path | Body | Success | Notes |
|---|---|---|---|
| `GET /api/ai/status` | — | `{enabled, model}` | `enabled` when `ANTHROPIC_API_KEY` is set. |
| `POST /api/ai/draft` | `{text}` (1–8000 chars) | `TicketDraft` | Asks Claude for `{title, description, impact, urgency, priority, severity, priorityReason, severityReason, labelIds, checklist, dueDate, kind, kindReason, parent, links}`. `parent` (an open work card) and `links` (`[{direction, card, reason}]`, open cards only, at most 5) are checked against the board; the prompt lists up to 50 open work cards and 100 recently updated open cards. Nothing is saved. `priority` is always `PRIORITY_MATRIX[impact][urgency]`; only existing labels are returned. 20 drafts per 10 minutes (`429 ai_draft_limit`). Errors: `503 ai_disabled`, `502 ai_bad_key`, `503 ai_rate_limited`, `503 ai_unreachable`, `503 ai_unavailable`, `422 ai_refused`, `502 ai_failed`. |
| `POST /api/ai/draft-many` | `{text}` (1–8000 chars) | `BulkDraft {cards, preview}` | "Describe several issues": Claude splits the text into cards in the [card-import format](CARD-IMPORT.md) (`cards`) and `preview` is the import's dry run. Nothing is saved; create them with `POST /api/import/cards {data: {cards}, dryRun: false}`. Counts as one draft; `422 ai_empty` when Claude finds nothing. |
| `POST /api/tickets` | `CreateCardBody` + `{checklist?: string[], links?: [{direction, cardId}], aiDrafted?: boolean}` | `201 CardDetail` | Creates the reviewed card (one checklist named "Checklist") and its links (all or nothing). History records `via: "Add ticket"` or `"Add ticket (Claude draft)"`. |

## Settings, submit page, automation (0.9)

| Method & path | Body | Success | Notes |
|---|---|---|---|
| `GET /api/settings` | — | `SettingsResponse` | General, submit page (including its `key`), Discord (the webhook is never returned, only `webhookSet` and a masked `webhookHint`), `notify` (`alerts` shared by every channel, and `channels.ntfy/gotify/webhook` with `set`, `hint`, `secretSet`, `events`, `lastDelivery`; addresses and secrets are never returned), and `blockedColumnId`. |
| `PUT /api/settings/general` | `GeneralSettingsBody {ticketFormat, appUrl, claudeModel}` | `SettingsResponse` | `ticketFormat` must end with `{N}` and can't contain `%` or `_`. |
| `PUT /api/settings/submit` | `SubmitSettingsBody {enabled, columnId, pageTitle, intro}` | `SettingsResponse` | Turning the page on the first time creates its key. |
| `POST /api/settings/submit/new-link` | — | `SettingsResponse` | A new key; the old link stops working. |
| `POST /api/settings/submit/reset-status-links` | — | `SettingsResponse` | A new signing secret; every status link handed out so far stops working. |
| `PUT /api/settings/resolutions` | `ResolutionReasonsBody {reasons}` | `SettingsResponse` | 1–12 reasons, each 1–40 characters, no duplicates (ignoring case). The first is the default. |
| `PUT /api/settings/discord` | `DiscordSettingsBody {webhookUrl, events, digestTime?, alertPriority?, alertSeverity?}` | `SettingsResponse` | `webhookUrl`: `null` keeps the saved one, `''` removes it; only `https://discord.com/api/webhooks/…` (or discordapp.com) is accepted. The optional fields keep their saved values when left out. |
| `POST /api/settings/discord/test` · `POST /api/settings/discord/digest-now` | — | `{ok, message, settings}` | Sends a test message / today's summary. |
| `PUT /api/settings/notify` | `NotifyAlertsBody {digestTime, alertPriority, alertSeverity}` | `SettingsResponse` | What counts as urgent and when the daily summary goes out, for every channel. |
| `PUT /api/settings/notify/ntfy` · `…/gotify` · `…/webhook` | `NotifyChannelBody {url, secret, events}` | `SettingsResponse` | `url` and `secret`: `null` keeps the saved value, `''` removes it. `url` must be `http(s)` without a user name or password; for ntfy it's the topic's address. A new `url` on another host forgets the saved secret unless one is sent too. `secret` is ntfy's access token, Gotify's app token (required to send) or the webhook's signing secret. |
| `POST /api/settings/notify/{ntfy\|gotify\|webhook}/test` · `…/digest-now` | — | `{ok, message, settings}` | Sends a test message / today's summary through that channel. `ok: false` with a message when it isn't set up or the send failed. `503` when the server runs without a notifier (tests). |
| `GET /api/request-types` | — | `RequestType[]` | |
| `POST /api/request-types` · `PUT /api/request-types/:id` | `RequestTypeBody` | `201` / `RequestType` | Questions: `{key, label, help, kind: short\|long\|choice\|multi\|datetime\|yesno, required, options}`; the title pattern may use `{summary}` and question keys. |
| `PUT /api/request-types/order` · `DELETE /api/request-types/:id` | `{ids}` / — | `RequestType[]` / `204` | |
| `GET /api/tokens` · `POST /api/tokens` · `DELETE /api/tokens/:id` | — / `{name, canComplete, scope?}` / — | `ApiTokenInfo[]` / `201 {token, info}` / `204` | The token is only in the create response. Delete revokes. `scope` is `full` (default) or `read`; a `read` token only gets `GET /api/v1/summary` and never completes tickets. |
| `GET /api/public/submit/:key` | — | `PublicSubmitConfig` | **No session.** `404` when the page is off or the key is wrong. |
| `POST /api/public/submit/:key` | multipart: `data` (JSON `SubmitBody`) + up to 3 `screenshots` | `201 {ticketNo, statusPath}` | **No session**, but needs `X-Requested-With`. `429 rate_limited` (5 per 10 min per address, 30 per hour overall). `statusPath` is the new ticket's status page. |
| `GET /api/public/status/:id/:sig` | — | `PublicTicketStatus {ticketNo, title, submittedAt, state, resolution, changedAt}` | **No session.** `state` is `received`, `in_progress`, `waiting` or `done`; `resolution` is the reason only. The same `404` for a bad signature, a work card, a card in the Trash or the page being off. `429 rate_limited` past 60 a minute per address. |
| `GET /api/v1/summary` | — | `ApiSummary` | **API token only**, read-only tokens included. Ticket counts for dashboards; see [API-V1.md](API-V1.md#get-apiv1summary). |
| `POST /api/v1/cards` | one card in the import format + `dedupeKey?`, `event?` | `201`/`200 {status, card}` | **API token only** (`Authorization: Bearer tt_…`), not read-only ones (`403 forbidden`). See [AUTOMATION.md](AUTOMATION.md). |
| `POST /api/v1/hooks/uptime-kuma` | Uptime Kuma's webhook JSON | `{status, card}` | Query: `labels`, `priority`, `severity`, `column`. |

## Health

`GET /health` returns `200 {"status":"ok"}`, or `503` if the DB or `/data` is unusable. No auth.

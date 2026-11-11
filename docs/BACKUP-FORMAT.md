# Backup file format

What's inside an export from **Backup & restore**, for anyone who wants to read one with a script, check one by
hand, or just know what they're storing. The format name is `tower-tracker-backup`, from the app's old name. It stays
that way so every backup, and anything that reads them, keeps working.

## Compatibility

- A backup records the **schema version** of the database it came from. Restore builds a database at that version,
  loads the rows, then upgrades it step by step. That's why a backup from any older version restores cleanly.
- A backup from a **newer** schema than the app knows is refused with a clear message.
- Within 1.x, schema changes only **add** tables and columns. So a reader written for one version can read later
  ones by ignoring what it doesn't recognize.
- The test suite restores backups from every schema version on each build (`server/test/upgrade.test.ts`).

## The files

Exports made before 1.2 are named `tower-tracker-backup-<time>`. Restore doesn't look at the file name, so they work
the same.

**JSON export** (`belltower-backup-<time>.json`): a single JSON document, described below.

**ZIP export** (`belltower-backup-<time>.zip`):

```
data.json                        the same JSON document
attachments/<card id>/<uuid>     one file per attachment, stored uncompressed
```

Restore reads only `data.json` and files matching `attachments/<digits>/<uuid>`; anything else in the ZIP is ignored.
A JSON-only export restores fine too: the cards keep their attachment entries, and the files are just missing.

## The document

```json
{
  "format": "tower-tracker-backup",
  "schemaVersion": 9,
  "appVersion": "1.5.0",
  "appTz": "America/Chicago",
  "exportedAt": "2026-10-28T05:18:00.239Z",
  "tables": {
    "columns": [ { "id": 1, "name": "Triage", "position": 0, "role": "triage", "created_at": "…" } ],
    "cards": [ … ],
    …
  }
}
```

| Field | Meaning |
|---|---|
| `format` | Always `"tower-tracker-backup"`. |
| `schemaVersion` | The database schema the rows belong to (see the history below). |
| `appVersion` | The app version that wrote it. Informational. |
| `appTz` | The app's time zone (`TZ`). Local dates in the data (due dates, ticket numbers, schedules) are in this zone; restore warns if it differs. |
| `exportedAt` | When it was made, UTC. |
| `tables` | Every exported table: an array of rows, each row an object of `column: value`, exactly as stored. |

**Values:**
- timestamps are UTC ISO 8601 with milliseconds (`2026-10-28T05:18:00.239Z`);
- dates are local `YYYY-MM-DD` and times local `HH:MM`;
- booleans are `0` / `1`;
- some columns hold JSON as text (noted below).

Rows are ordered by `id`, or by their key for tables without one.

## Tables

Listed in the order restore loads them (parents first). Columns are those of the current schema (9); the full
definitions, with every constraint, are the migrations in
[`server/src/db/schema.ts`](../server/src/db/schema.ts).

| Table | What it holds | Notable columns |
|---|---|---|
| `settings` | App settings, one JSON or text value per key | `key`, `value` |
| `users` | People: admins and members (deactivated, never deleted). **No passwords** | `username`, `display_name`, `email`, `role` (`admin`, `member`), `is_owner`, `oidc_issuer`, `oidc_subject` (a single sign-on link; exported, but restore takes links from the server you restore into), `discord_user_id`, `ntfy_topic`, `notify_prefs` (JSON), `disabled_at` |
| `columns` | Board columns | `name`, `position`, `role` (`triage`, `done` or null) |
| `labels` | Labels | `name`, `color` (`#rrggbb`), `position` |
| `recurring_templates` | Recurring maintenance | `title`, `interval_unit`, `interval_count`, `next_run_date`, `checklist_template` (JSON), `enabled` |
| `recurring_template_labels` | Labels on templates | `template_id`, `label_id` |
| `cards` | Every card, including archived and trashed ones | `column_id`, `title`, `description_md`, `priority`, `severity`, `due_date`, `due_time`, `position`, `completed_at`, `archived_at`, `deleted_at`, `source` (`manual`, `recurring`, `api`), `source_ref` (an automation `dedupeKey`), `ticket_no`, `kind` (`ticket`, `work`), `parent_id`, `resolution`, `resolution_md`, `assignee_id` (a user) |
| `card_labels` | Labels on cards | `card_id`, `label_id` |
| `card_watchers` | Who watches which card | `card_id`, `user_id` |
| `checklists` | Checklists | `card_id`, `title`, `position` |
| `checklist_items` | Their items | `checklist_id`, `text`, `state` (`open`, `done`, `failed`, `unverified`), `checked` (`1` only when `done`), `checked_at` (when the current mark was set), `position` |
| `attachments` | Attachment metadata (the file is in the ZIP) | `card_id`, `original_name`, `stored_name` (UUID), `mime_type`, `kind` (`image`, `text`, `file`), `size_bytes`, `sha256` |
| `card_links` | Links between cards | `from_card_id`, `to_card_id`, `type`: `blocks` (from blocks to) or `relates` (stored once, lower id first) |
| `api_tokens` | Automation tokens: **hashes only**, never the token itself | `name`, `token_hash`, `prefix`, `can_complete`, `scope` (`full` or `read`), `revoked_at`, `user_id` (who it acts for) |
| `activity` | The history and work log | `card_id`, `kind` (`event`, `worklog`), `type`, `data` (JSON), `body_md` (work log text), `occurred_at`, `edited_at`, `retracted_at`, `user_id` (who did it; for a token, its owner), `token_id` (the token, if one was used) |
| `activity_revisions` | Earlier versions of edited work-log entries | `activity_id`, `body_md`, `occurred_at`, `revised_at`, `user_id` (who made the edit) |
| `template_runs` | What each recurring template created, and when | `template_id`, `occurrence_date`, `outcome`, `card_id` |
| `request_types` | Submit page request types | `name`, `title_pattern`, `fields` (JSON), `tag_label_ids` (JSON), `enabled` |

The shapes of `activity.data` for each event type are documented with `ActivityEntry` in
[`shared/src/types.ts`](../shared/src/types.ts). New event types may appear in later versions, so treat unknown ones
generically. `user_id` and `token_id` are null for history from before 1.5, and for what the submit page, recurring
templates and the app itself did.

**Settings keys** you'll see: `general_settings`, `submit_settings` (which includes the submit page's key),
`discord_settings` (which includes the webhook URL, and the alert levels and summary time every channel uses),
`notify_channels` (ntfy, Gotify and webhook addresses and tokens), `<channel>_last_delivery` and
`<channel>_digest_last` for `discord`, `ntfy`, `gotify` and `webhook`,
`resolution_reasons`, `blocked_column_id`, `teams_settings` (Settings → General → Teams, since 1.5),
`status_link_secret` (signs ticket status links), `app_tz_at_seed`, `seeded` and `request_types_seeded`.

## What's left out

- **Passwords** (`users.password_hash`; before 1.5 the `password_hash` setting), `password_source`, and **signed-in
  devices** (`sessions`). On restore, the server you restore into decides who can sign in: each of its people is
  matched to the backup's by username and keeps their own password, role, deactivation and single sign-on link, its
  people the backup doesn't have are added, and everyone stays signed in. People only in the backup come back without a
  password or single sign-on link until an admin gives them a new password. A `password_hash`, `is_owner`,
  `oidc_issuer` or `oidc_subject` in a backup (say, a hand-edited one) is ignored on restore.
- **Single sign-on settings** (`oidc_settings`, client secret included). They belong to the install: a restore keeps
  the live install's, and an `oidc_settings` row in a backup (say, a hand-edited one) is ignored.
- **Personal notifications** (`notifications`). They're each person's inbox, pruned as they age, not data worth
  restoring.
- **The search index** (`card_search`). It's rebuilt from the cards on restore.

Because a backup does include the submit page's link, the secret that signs status links, notification addresses and
tokens and API token hashes, keep exports somewhere private.

## Schema history

| Schema | Version | Added |
|---|---|---|
| 1 | 0.1 | The original tables: board, cards, checklists, attachments, links, history, recurring templates |
| 2 | 0.2–0.5 | `cards.severity` |
| 3 | 0.6 | `cards.ticket_no` (cards from older backups are numbered on restore) |
| 4 | 0.7 | `cards.kind`, `cards.parent_id` (work cards) |
| 5 | 0.9 | `request_types`, `api_tokens` |
| 6 | 0.10 | `cards.resolution`, `cards.resolution_md` |
| 7 | 1.3 | `api_tokens.scope` (`full` or `read`; tokens from older backups come back as `full`) |
| 8 | 1.4 | `checklist_items.state` (`open`, `done`, `failed` or `unverified`; checked items from older backups come back as `done`) |
| 9 | 1.5 | `users` (people; exported without passwords), `card_watchers`, `cards.assignee_id`, `activity.user_id` and `token_id`, `activity_revisions.user_id`, `api_tokens.user_id`. Backups from older versions have no people: the server you restore into adds its own, and their API tokens go to its owner |

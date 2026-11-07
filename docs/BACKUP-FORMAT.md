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
  "schemaVersion": 6,
  "appVersion": "1.0.0",
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

Listed in the order restore loads them (parents first). Columns are those of the current schema (6); the full
definitions, with every constraint, are the migrations in
[`server/src/db/schema.ts`](../server/src/db/schema.ts).

| Table | What it holds | Notable columns |
|---|---|---|
| `settings` | App settings, one JSON or text value per key | `key`, `value` |
| `columns` | Board columns | `name`, `position`, `role` (`triage`, `done` or null) |
| `labels` | Labels | `name`, `color` (`#rrggbb`), `position` |
| `recurring_templates` | Recurring maintenance | `title`, `interval_unit`, `interval_count`, `next_run_date`, `checklist_template` (JSON), `enabled` |
| `recurring_template_labels` | Labels on templates | `template_id`, `label_id` |
| `cards` | Every card, including archived and trashed ones | `column_id`, `title`, `description_md`, `priority`, `severity`, `due_date`, `due_time`, `position`, `completed_at`, `archived_at`, `deleted_at`, `source` (`manual`, `recurring`, `api`), `source_ref` (an automation `dedupeKey`), `ticket_no`, `kind` (`ticket`, `work`), `parent_id`, `resolution`, `resolution_md` |
| `card_labels` | Labels on cards | `card_id`, `label_id` |
| `checklists` | Checklists | `card_id`, `title`, `position` |
| `checklist_items` | Their items | `checklist_id`, `text`, `checked`, `checked_at`, `position` |
| `attachments` | Attachment metadata (the file is in the ZIP) | `card_id`, `original_name`, `stored_name` (UUID), `mime_type`, `kind` (`image`, `text`, `file`), `size_bytes`, `sha256` |
| `card_links` | Links between cards | `from_card_id`, `to_card_id`, `type`: `blocks` (from blocks to) or `relates` (stored once, lower id first) |
| `activity` | The history and work log | `card_id`, `kind` (`event`, `worklog`), `type`, `data` (JSON), `body_md` (work log text), `occurred_at`, `edited_at`, `retracted_at` |
| `activity_revisions` | Earlier versions of edited work-log entries | `activity_id`, `body_md`, `occurred_at`, `revised_at` |
| `template_runs` | What each recurring template created, and when | `template_id`, `occurrence_date`, `outcome`, `card_id` |
| `request_types` | Submit page request types | `name`, `title_pattern`, `fields` (JSON), `tag_label_ids` (JSON), `enabled` |
| `api_tokens` | Automation tokens: **hashes only**, never the token itself | `name`, `token_hash`, `prefix`, `can_complete`, `revoked_at` |

The shapes of `activity.data` for each event type are documented with `ActivityEntry` in
[`shared/src/types.ts`](../shared/src/types.ts). New event types may appear in later versions, so treat unknown ones
generically.

**Settings keys** you'll see: `general_settings`, `submit_settings` (which includes the submit page's key),
`discord_settings` (which includes the webhook URL), `discord_last_delivery`, `discord_digest_last`,
`resolution_reasons`, `blocked_column_id`, `app_tz_at_seed`, `seeded` and `request_types_seeded`.

## What's left out

- **The password** (`password_hash`, `password_source`) and **signed-in devices** (`sessions`). A restore keeps the
  ones already on the server, so it never locks you out.
- **The search index** (`card_search`). It's rebuilt from the cards on restore.

Because a backup does include the submit page's link, the Discord webhook URL and token hashes, keep exports
somewhere private.

## Schema history

| Schema | Version | Added |
|---|---|---|
| 1 | 0.1 | The original tables: board, cards, checklists, attachments, links, history, recurring templates |
| 2 | 0.2–0.5 | `cards.severity` |
| 3 | 0.6 | `cards.ticket_no` (cards from older backups are numbered on restore) |
| 4 | 0.7 | `cards.kind`, `cards.parent_id` (work cards) |
| 5 | 0.9 | `request_types`, `api_tokens` |
| 6 | 0.10 | `cards.resolution`, `cards.resolution_md` |

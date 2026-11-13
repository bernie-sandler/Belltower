// Forward-only schema migrations. Never edit a migration that has shipped; add a new one.
// Version is tracked in PRAGMA user_version. The append-only guard triggers are (re)created after
// every migration by migrate.ts, so migrations themselves may rebuild the activity tables.

/** Every timestamp the app writes comes from Date#toISOString(): '2026-10-10T19:04:05.123Z'. */
const ISO_GLOB = "'[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-6][0-9].[0-9][0-9][0-9]Z'";
const DATE_GLOB = "'[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'";
const UUID_GLOB = `'${[8, 4, 4, 4, 12].map((n) => '[0-9a-f]'.repeat(n)).join('-')}'`;

const ts = (col: string) => `${col} TEXT NOT NULL CHECK (${col} GLOB ${ISO_GLOB})`;
const tsNull = (col: string) => `${col} TEXT CHECK (${col} IS NULL OR ${col} GLOB ${ISO_GLOB})`;
const date = (col: string) => `${col} TEXT NOT NULL CHECK (${col} GLOB ${DATE_GLOB})`;
const dateNull = (col: string) => `${col} TEXT CHECK (${col} IS NULL OR ${col} GLOB ${DATE_GLOB})`;
const PRIORITY = `TEXT CHECK (priority IN ('critical', 'high', 'medium', 'low'))`;

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const v1 = `
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE sessions (
  id           INTEGER PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  ${ts('created_at')},
  ${ts('last_seen_at')},
  ${ts('expires_at')},
  remember     INTEGER NOT NULL CHECK (remember IN (0, 1)),
  user_agent   TEXT,
  ip           TEXT
) STRICT;
CREATE INDEX ix_sessions_expires ON sessions (expires_at);

CREATE TABLE columns (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  position INTEGER NOT NULL,
  role     TEXT CHECK (role IN ('triage', 'done')),
  ${ts('created_at')}
) STRICT;
CREATE UNIQUE INDEX ux_columns_role ON columns (role) WHERE role IS NOT NULL;

CREATE TABLE labels (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(name) BETWEEN 1 AND 40),
  color    TEXT NOT NULL CHECK (color GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
  position INTEGER NOT NULL,
  ${ts('created_at')}
) STRICT;

CREATE TABLE recurring_templates (
  id                 INTEGER PRIMARY KEY,
  title              TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  description_md     TEXT NOT NULL DEFAULT '',
  priority           ${PRIORITY},
  checklist_template TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(checklist_template)),
  interval_unit      TEXT NOT NULL CHECK (interval_unit IN ('day', 'week', 'month')),
  interval_count     INTEGER NOT NULL CHECK (interval_count BETWEEN 1 AND 1000),
  ${date('start_date')},
  ${date('next_run_date')},
  due_in_days        INTEGER CHECK (due_in_days IS NULL OR due_in_days BETWEEN 0 AND 3650),
  enabled            INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  ${ts('created_at')},
  ${ts('updated_at')}
) STRICT;

CREATE TABLE recurring_template_labels (
  template_id INTEGER NOT NULL REFERENCES recurring_templates (id) ON DELETE CASCADE,
  label_id    INTEGER NOT NULL REFERENCES labels (id) ON DELETE CASCADE,
  PRIMARY KEY (template_id, label_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE cards (
  id             INTEGER PRIMARY KEY,
  column_id      INTEGER NOT NULL REFERENCES columns (id) ON DELETE RESTRICT,
  title          TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  description_md TEXT NOT NULL DEFAULT '',
  priority       ${PRIORITY},
  ${dateNull('due_date')},
  due_time       TEXT CHECK (due_time IS NULL OR due_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  position       INTEGER NOT NULL DEFAULT 0,
  version        INTEGER NOT NULL DEFAULT 1,
  ${tsNull('completed_at')},
  ${tsNull('archived_at')},
  ${tsNull('deleted_at')},
  source         TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'recurring', 'api')),
  source_ref     TEXT,
  template_id    INTEGER REFERENCES recurring_templates (id) ON DELETE SET NULL,
  ${ts('created_at')},
  ${ts('updated_at')},
  CHECK (due_time IS NULL OR due_date IS NOT NULL)
) STRICT;
CREATE INDEX ix_cards_column ON cards (column_id, position);
CREATE INDEX ix_cards_due ON cards (due_date) WHERE due_date IS NOT NULL;
CREATE INDEX ix_cards_completed ON cards (completed_at) WHERE completed_at IS NOT NULL;
CREATE INDEX ix_cards_template ON cards (template_id) WHERE template_id IS NOT NULL;
CREATE INDEX ix_cards_source_ref ON cards (source_ref) WHERE source_ref IS NOT NULL;

CREATE TABLE card_labels (
  card_id  INTEGER NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
  label_id INTEGER NOT NULL REFERENCES labels (id) ON DELETE CASCADE,
  PRIMARY KEY (card_id, label_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX ix_card_labels_label ON card_labels (label_id);

CREATE TABLE checklists (
  id       INTEGER PRIMARY KEY,
  card_id  INTEGER NOT NULL REFERENCES cards (id),
  title    TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  position INTEGER NOT NULL,
  ${ts('created_at')}
) STRICT;
CREATE INDEX ix_checklists_card ON checklists (card_id, position);

CREATE TABLE checklist_items (
  id           INTEGER PRIMARY KEY,
  checklist_id INTEGER NOT NULL REFERENCES checklists (id) ON DELETE CASCADE,
  text         TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 1000),
  checked      INTEGER NOT NULL DEFAULT 0 CHECK (checked IN (0, 1)),
  ${tsNull('checked_at')},
  position     INTEGER NOT NULL,
  ${ts('created_at')}
) STRICT;
CREATE INDEX ix_checklist_items_list ON checklist_items (checklist_id, position);

CREATE TABLE attachments (
  id            INTEGER PRIMARY KEY,
  card_id       INTEGER NOT NULL REFERENCES cards (id),
  original_name TEXT NOT NULL CHECK (length(original_name) BETWEEN 1 AND 255),
  stored_name   TEXT NOT NULL UNIQUE CHECK (stored_name GLOB ${UUID_GLOB}),
  mime_type     TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('image', 'text', 'file')),
  size_bytes    INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256        TEXT NOT NULL CHECK (length(sha256) = 64),
  ${ts('created_at')}
) STRICT;
CREATE INDEX ix_attachments_card ON attachments (card_id);

CREATE TABLE card_links (
  id           INTEGER PRIMARY KEY,
  from_card_id INTEGER NOT NULL REFERENCES cards (id),
  to_card_id   INTEGER NOT NULL REFERENCES cards (id),
  type         TEXT NOT NULL CHECK (type IN ('relates', 'blocks')),
  ${ts('created_at')},
  CHECK (from_card_id <> to_card_id),
  CHECK (type <> 'relates' OR from_card_id < to_card_id),
  UNIQUE (from_card_id, to_card_id, type)
) STRICT;
CREATE INDEX ix_card_links_to ON card_links (to_card_id);

CREATE TABLE activity (
  id           INTEGER PRIMARY KEY,
  card_id      INTEGER NOT NULL REFERENCES cards (id),
  kind         TEXT NOT NULL CHECK (kind IN ('event', 'worklog')),
  type         TEXT NOT NULL,
  data         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data)),
  body_md      TEXT,
  ${ts('occurred_at')},
  ${ts('created_at')},
  ${tsNull('edited_at')},
  ${tsNull('retracted_at')},
  CHECK ((kind = 'worklog') = (type = 'worklog')),
  CHECK (kind = 'event' OR body_md IS NOT NULL)
) STRICT;
CREATE INDEX ix_activity_card ON activity (card_id, occurred_at);
CREATE INDEX ix_activity_type ON activity (type, occurred_at);

CREATE TABLE activity_revisions (
  id          INTEGER PRIMARY KEY,
  activity_id INTEGER NOT NULL REFERENCES activity (id),
  body_md     TEXT NOT NULL,
  ${ts('occurred_at')},
  ${ts('revised_at')}
) STRICT;
CREATE INDEX ix_activity_revisions_activity ON activity_revisions (activity_id);

CREATE TABLE template_runs (
  id              INTEGER PRIMARY KEY,
  template_id     INTEGER NOT NULL REFERENCES recurring_templates (id) ON DELETE CASCADE,
  ${dateNull('occurrence_date')},
  outcome         TEXT NOT NULL CHECK (outcome IN ('created', 'skipped_open', 'manual')),
  card_id         INTEGER REFERENCES cards (id),
  ${ts('ran_at')},
  UNIQUE (template_id, occurrence_date)
) STRICT;

CREATE VIRTUAL TABLE card_search USING fts5 (
  title, description, checklists, worklogs, history,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

const v2 = `
ALTER TABLE cards ADD COLUMN severity TEXT CHECK (severity IN ('blocker', 'major', 'minor', 'trivial'));
`;

// Ticket numbers ("YYMMDD-N", the local creation date plus a per-day counter). Existing cards are
// numbered by assignTicketNumbers() at startup / after a restore, which knows the app time zone.
const v3 = `
ALTER TABLE cards ADD COLUMN ticket_no TEXT;
CREATE UNIQUE INDEX ux_cards_ticket_no ON cards (ticket_no) WHERE ticket_no IS NOT NULL;
`;

// Work cards and "part of": a ticket can be filed under one work card (one level only; the rules
// live in services/cards.ts).
const v4 = `
ALTER TABLE cards ADD COLUMN kind TEXT NOT NULL DEFAULT 'ticket' CHECK (kind IN ('ticket', 'work'));
ALTER TABLE cards ADD COLUMN parent_id INTEGER REFERENCES cards (id);
CREATE INDEX ix_cards_parent ON cards (parent_id) WHERE parent_id IS NOT NULL;
`;

// 0.9: submit-page request types (questions and tags as validated JSON) and API tokens for
// automation (only a SHA-256 hash of each token is stored). Default request types are seeded at
// startup, not here, so a restored backup's rows never collide with seeded ones.
const v5 = `
CREATE TABLE request_types (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  description   TEXT NOT NULL DEFAULT '',
  title_pattern TEXT NOT NULL DEFAULT '{summary}',
  fields        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(fields)),
  tag_label_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tag_label_ids)),
  type_label_id INTEGER REFERENCES labels (id) ON DELETE SET NULL,
  position      INTEGER NOT NULL DEFAULT 0,
  enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  ${ts('created_at')},
  ${ts('updated_at')}
) STRICT;
CREATE TABLE api_tokens (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  token_hash   TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,
  can_complete INTEGER NOT NULL DEFAULT 0 CHECK (can_complete IN (0, 1)),
  ${ts('created_at')},
  ${tsNull('last_used_at')},
  ${tsNull('revoked_at')}
) STRICT;
`;

// 0.10: how a card was resolved (reason from Settings' list, kept as text so renaming a reason
// doesn't rewrite history) and an optional note.
const v6 = `
ALTER TABLE cards ADD COLUMN resolution TEXT CHECK (resolution IS NULL OR length(resolution) BETWEEN 1 AND 40);
ALTER TABLE cards ADD COLUMN resolution_md TEXT NOT NULL DEFAULT '';
`;

// 1.3: read-only API tokens, for dashboards that only read GET /api/v1/summary. Existing tokens
// keep doing everything they did ('full').
const v7 = `
ALTER TABLE api_tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'full' CHECK (scope IN ('full', 'read'));
`;

// 1.4: checklist items can be failed (✗) or unverified (~) as well as done. `checked` and
// `checked_at` stay and are kept in step (checked = 1 only for 'done'), so older readers keep
// working; items checked before this come back as 'done'.
const v8 = `
ALTER TABLE checklist_items ADD COLUMN state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'done', 'failed', 'unverified'));
UPDATE checklist_items SET state = 'done' WHERE checked = 1;
`;

/** SQLite's own clock, in the same ISO format as ISO_GLOB (only used when a migration has no better time). */
const SQL_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

// 1.5: people. Everything 1.5 needs is in this one migration (assignees, watchers and personal
// notifications are used by later 1.5 changes), since a shipped migration can't change.
//  - users: the single 1.4 password becomes the owner account `admin` (created_at from the oldest
//    column, so it's stable). Roles are checked in code, not here, so a role can be added later
//    without rebuilding the table.
//  - who did it: activity.user_id / token_id and activity_revisions.user_id. Nullable, and no
//    ON DELETE action: a cascade would UPDATE the activity log, which the guards refuse. Users are
//    deactivated, never deleted.
//  - existing sessions and API tokens belong to the owner, so nobody is signed out and automations
//    keep working. The password_hash setting goes (the pre-migration copy keeps it); password_source
//    stays and now means "the owner's password comes from APP_PASSWORD".
const v9 = `
CREATE TABLE users (
  id              INTEGER PRIMARY KEY,
  username        TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (
                    length(username) BETWEEN 2 AND 32
                    AND username NOT GLOB '*[^a-z0-9._-]*'
                    AND lower(username) <> 'tower-tracker'),
  display_name    TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 60),
  email           TEXT CHECK (email IS NULL OR length(email) BETWEEN 3 AND 254),
  role            TEXT NOT NULL DEFAULT 'member' CHECK (length(role) BETWEEN 1 AND 20),
  is_owner        INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0, 1)),
  password_hash   TEXT,
  oidc_issuer     TEXT,
  oidc_subject    TEXT,
  discord_user_id TEXT CHECK (discord_user_id IS NULL OR (length(discord_user_id) BETWEEN 17 AND 20 AND discord_user_id NOT GLOB '*[^0-9]*')),
  ntfy_topic      TEXT CHECK (ntfy_topic IS NULL OR (length(ntfy_topic) BETWEEN 1 AND 64 AND ntfy_topic NOT GLOB '*[^A-Za-z0-9_-]*')),
  notify_prefs    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(notify_prefs)),
  ${ts('created_at')},
  ${tsNull('disabled_at')},
  CHECK ((oidc_issuer IS NULL) = (oidc_subject IS NULL))
) STRICT;
CREATE UNIQUE INDEX ux_users_owner ON users (is_owner) WHERE is_owner = 1;
CREATE UNIQUE INDEX ux_users_oidc ON users (oidc_issuer, oidc_subject) WHERE oidc_subject IS NOT NULL;

INSERT INTO users (username, display_name, role, is_owner, password_hash, created_at)
SELECT 'admin', 'Admin', 'admin', 1, value, coalesce((SELECT min(created_at) FROM columns), ${SQL_NOW})
  FROM settings WHERE key = 'password_hash';

ALTER TABLE sessions ADD COLUMN user_id INTEGER REFERENCES users (id);
ALTER TABLE api_tokens ADD COLUMN user_id INTEGER REFERENCES users (id);
ALTER TABLE activity ADD COLUMN user_id INTEGER REFERENCES users (id);
ALTER TABLE activity ADD COLUMN token_id INTEGER REFERENCES api_tokens (id);
ALTER TABLE activity_revisions ADD COLUMN user_id INTEGER REFERENCES users (id);
ALTER TABLE cards ADD COLUMN assignee_id INTEGER REFERENCES users (id);

UPDATE sessions SET user_id = (SELECT id FROM users WHERE is_owner = 1);
UPDATE api_tokens SET user_id = (SELECT id FROM users WHERE is_owner = 1);
DELETE FROM sessions WHERE user_id IS NULL;
DELETE FROM settings WHERE key = 'password_hash';

CREATE INDEX ix_sessions_user ON sessions (user_id);
CREATE INDEX ix_api_tokens_user ON api_tokens (user_id);
CREATE INDEX ix_cards_assignee ON cards (assignee_id) WHERE assignee_id IS NOT NULL;

CREATE TABLE card_watchers (
  card_id INTEGER NOT NULL REFERENCES cards (id),
  user_id INTEGER NOT NULL REFERENCES users (id),
  ${ts('created_at')},
  PRIMARY KEY (card_id, user_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX ix_card_watchers_user ON card_watchers (user_id);

CREATE TABLE notifications (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users (id),
  card_id       INTEGER NOT NULL REFERENCES cards (id),
  activity_id   INTEGER REFERENCES activity (id),
  type          TEXT NOT NULL CHECK (length(type) BETWEEN 1 AND 40),
  actor_user_id INTEGER REFERENCES users (id),
  data          TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data)),
  ${ts('created_at')},
  ${tsNull('read_at')}
) STRICT;
CREATE INDEX ix_notifications_user ON notifications (user_id, id);
CREATE INDEX ix_notifications_unread ON notifications (user_id) WHERE read_at IS NULL;
CREATE UNIQUE INDEX ux_notifications_once ON notifications (user_id, activity_id, type) WHERE activity_id IS NOT NULL;
`;

// 1.5 (rc.4): request types say which labels every ticket of that type gets; submitters no longer pick
// tags. The one "always add" label (type_label_id) carries over; the old pick lists
// (tag_label_ids) are dropped, as decided for 1.5. Both v5 columns stay (a shipped column can't be
// dropped) but are unused from here on: emptied now and never written again.
const v10 = `
CREATE TABLE request_type_labels (
  request_type_id INTEGER NOT NULL REFERENCES request_types (id) ON DELETE CASCADE,
  label_id        INTEGER NOT NULL REFERENCES labels (id) ON DELETE CASCADE,
  PRIMARY KEY (request_type_id, label_id)
) STRICT, WITHOUT ROWID;

INSERT INTO request_type_labels (request_type_id, label_id)
SELECT id, type_label_id FROM request_types WHERE type_label_id IN (SELECT id FROM labels);
UPDATE request_types SET type_label_id = NULL, tag_label_ids = '[]';
`;

// 1.5 (rc.4): tag-restricted accounts. An admin can limit a member to cards carrying one of their tags.
//  - users.tag_scoped: 1 = restricted. Kept apart from the tag list so a restricted account whose
//    tags were all deleted still counts as restricted and sees nothing (fails closed).
//  - user_labels: the tags a restricted account sees. Deleting a tag or a person removes the rows.
const v11 = `
ALTER TABLE users ADD COLUMN tag_scoped INTEGER NOT NULL DEFAULT 0 CHECK (tag_scoped IN (0, 1));

CREATE TABLE user_labels (
  user_id  INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  label_id INTEGER NOT NULL REFERENCES labels (id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, label_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX ix_user_labels_label ON user_labels (label_id);
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial schema', sql: v1 },
  { version: 2, name: 'card severity', sql: v2 },
  { version: 3, name: 'ticket numbers', sql: v3 },
  { version: 4, name: 'work cards', sql: v4 },
  { version: 5, name: 'submit page and API tokens', sql: v5 },
  { version: 6, name: 'resolution notes', sql: v6 },
  { version: 7, name: 'read-only API tokens', sql: v7 },
  { version: 8, name: 'checklist item states', sql: v8 },
  { version: 9, name: 'people', sql: v9 },
  { version: 10, name: 'request type labels', sql: v10 },
  { version: 11, name: 'tag-restricted accounts', sql: v11 },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/**
 * Append-only guards for the activity log. Work-log entries may only change body, effective time,
 * edit time and retraction; events are immutable; nothing in either table is ever deleted.
 */
export const GUARD_TRIGGER_NAMES = [
  'activity_no_delete',
  'activity_no_replace',
  'activity_guard_update',
  'activity_revisions_no_delete',
  'activity_revisions_no_replace',
  'activity_revisions_no_update',
] as const;

/**
 * The guards for a database at schema `version`. They depend on it: SQLite accepts a trigger that
 * names a column the table doesn't have yet, and then fails every UPDATE on that table with "no such
 * column". Upgrades and restores run old migration steps on old tables, so the work-log author
 * columns (schema 9) are only frozen once they exist.
 */
export function guardsSql(version: number): string {
  const frozen = ['id', 'card_id', 'kind', 'type', 'data', 'created_at', ...(version >= 9 ? ['user_id', 'token_id'] : [])];
  return `
CREATE TRIGGER activity_no_delete BEFORE DELETE ON activity
BEGIN SELECT RAISE(ABORT, 'activity is append-only'); END;

-- INSERT OR REPLACE deletes the old row without firing DELETE triggers; refuse it up front.
CREATE TRIGGER activity_no_replace BEFORE INSERT ON activity
WHEN NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM activity WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'activity is append-only'); END;

CREATE TRIGGER activity_guard_update BEFORE UPDATE ON activity
WHEN OLD.kind <> 'worklog'
${frozen.map((c) => `  OR NEW.${c} IS NOT OLD.${c}`).join('\n')}
BEGIN SELECT RAISE(ABORT, 'activity is append-only: only a work-log body, time, edit time or retraction may change'); END;

CREATE TRIGGER activity_revisions_no_delete BEFORE DELETE ON activity_revisions
BEGIN SELECT RAISE(ABORT, 'activity_revisions is append-only'); END;

CREATE TRIGGER activity_revisions_no_replace BEFORE INSERT ON activity_revisions
WHEN NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM activity_revisions WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'activity_revisions is append-only'); END;

CREATE TRIGGER activity_revisions_no_update BEFORE UPDATE ON activity_revisions
BEGIN SELECT RAISE(ABORT, 'activity_revisions is append-only'); END;
`;
}

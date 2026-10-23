# Tower Tracker — Design (v1 proposal)

Status: **approved 2026-10-10; Phase 1 complete**. This is the reference for implementation; items marked
*(default — override?)* are judgment calls the owner can still change.

### Decisions from owner answers (2026-10-10)

- **Phone access**: the phone uses either plain `http://tower:8080` over Tailscale, or an HTTPS hostname through
  Nginx Proxy Manager. Both are first-class.
  - With NPM, set `TRUST_PROXY=<NPM VM LAN IP>`.
  - The README covers the NPM proxy host: an Access List limited to the LAN and `100.64.0.0/10` (because 80/443
    are forwarded, a proxy host is internet-reachable by hostname otherwise), plus `client_max_body_size` for
    uploads and restores.
- **Install**: Docker Compose Manager plugin. `docker-compose.yml` uses `build: .` and `image: tower-tracker:local`.
  **No Unraid XML template.**
- **Phone**: iPhone (iOS Safari) is the primary mobile test target.
  - Inputs use 16px fonts so iOS doesn't zoom; layout uses `100dvh` and safe-area insets.
  - `-webkit-touch-callout: none` on tiles.
  - The photo picker uses `accept="image/*"`, and HEIC is handled as a fallback.
  - The Home Screen app needs its own login once, since it has a separate cookie jar from Safari.
- **Storage**: appdata is on the cache pool; whether its "Exclusive access" flag is on is unconfirmed.
  - Compose maps `/mnt/user/appdata/tower-tracker`.
  - The README explains how to check Exclusive access, and says to map `/mnt/cache/appdata/tower-tracker`
    directly if it reads "No".

---

## 1. Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Node.js 24 LTS** on `node:24-bookworm-slim` (dev/test on host Node 22 is fine) | One language front + back with shared validation schemas. Node 22 hits EOL Apr 2027; 24 is supported to Apr 2028. Debian slim already has `setpriv` (for PUID/PGID) and `tzdata`. |
| Language | **TypeScript** everywhere | Shared types between API and UI; catches whole classes of bugs. |
| HTTP server | **Fastify 5** + `@fastify/cookie`, `@fastify/multipart`, `@fastify/static` | Fast, small, first-class streaming multipart, `inject()` for route tests. Security headers set explicitly (no helmet — its defaults add HSTS + `upgrade-insecure-requests`, which break plain-HTTP LAN/Tailscale access). |
| Database | **SQLite via better-sqlite3 13** (bundles SQLite 3.53 with FTS5; prebuilt binaries, no compiler in the image) | Synchronous API makes transactions trivial and fast; FTS5 built in; one file under `/data`. WAL mode, `foreign_keys=ON`, `busy_timeout`. |
| Validation | **zod** (schemas in `/shared`, used by server and client) | Single source of truth for request/response shapes and env parsing. |
| Password hash | Node built-in **`crypto.scrypt`** (N=2¹⁶, r=8, p=1, maxmem 128 MiB, 16-byte salt) | No native dependency; ~200 ms per verify; verifications run single-flight so a login burst can't eat RAM on a box that also runs Plex. |
| Zip | **archiver** (streaming export), **yauzl** (import, `lazyEntries`) | Streams multi-GB backups without buffering in memory. |
| Frontend | **React 19 + Vite 8**, **react-router 8** (declarative mode), **TanStack Query 5** | Highly interactive UI (optimistic drag/drop, modals, paste/drop uploads) — not a fit for server-rendered/htmx. TanStack Query gives caching, focus-refetch (keeps phone + desktop in sync) and serialized optimistic moves. |
| Drag & drop | **@dnd-kit/core 6.3 + /sortable 10** | Mature, supports mouse, touch (long-press) and keyboard; `DragOverlay` + auto-scroll for multi-column kanban. |
| Markdown | **markdown-it 15** (`html:false`, `linkify:true`) | Raw HTML is escaped and `javascript:`/`data:text/html` links are refused (verified), so no sanitizer is needed. |
| Dates/TZ | **date-fns 4 + @date-fns/tz** (`TZDate`), plus a tiny pure `localdate` module for date-only math | All display and bucketing in the app TZ (America/Chicago) regardless of device TZ; handles DST correctly. |
| Icons / fonts | **lucide-react** (tree-shaken), **system font stack** | Fully bundled, no CDN, no font download. |
| Calendar | **Custom** month/week components | FullCalendar 7 pulls a Temporal polyfill + extra peers and needs heavy dark-theme work; our needs are simple. |
| Tests | **Vitest** (server services with injectable clock, file-based temp DBs; `fastify.inject` route tests). Recurrence/calendar tests run under both `TZ=America/Chicago` and `TZ=Pacific/Auckland`. | |

Rejected: Python/FastAPI (would still need the same JS frontend, so two languages), Go (not installed here; same JS frontend), SvelteKit (smaller bundle doesn't matter on a LAN; weaker touch-DnD ecosystem), htmx (poor fit for optimistic drag/drop).

---

## 2. Data model

All instants are UTC ISO-8601 strings written by one `now()` helper (`2026-10-10T19:04:05.123Z`); SQL defaults use
`strftime('%Y-%m-%dT%H:%M:%fZ','now')` so string comparison is always correct. "Local date" fields are `YYYY-MM-DD`
in the app TZ. Schema version is tracked with `PRAGMA user_version`; migrations are forward-only `.sql` files.

### Core tables

```
settings          key PK, value
                  -- password_hash (scrypt$…), password_source ('env'|'ui'), seeded, app_tz_at_seed

sessions          id PK, token_hash UNIQUE (sha256 of 32-byte token), created_at, last_seen_at,
                  expires_at, remember (0/1), user_agent, ip

columns           id PK, name, position INT, role NULL CHECK(role IN ('triage','done')), created_at
                  UNIQUE INDEX on role WHERE role IS NOT NULL   -- exactly one Triage, one Done
                  -- role columns can be renamed/reordered, not deleted

cards             id PK, column_id NOT NULL → columns (RESTRICT), title, description_md,
                  priority NULL CHECK(critical|high|medium|low),
                  due_date NULL (local date), due_time NULL ('HH:MM' local; NULL = all-day),
                  position INT, version INT (optimistic-concurrency counter),
                  completed_at NULL  -- set on entering Done, editable (backdate), cleared on leaving
                  archived_at NULL, deleted_at NULL  -- soft delete → Trash; never hard-deleted
                  source ('manual'|'recurring'|'api'), source_ref NULL (v2 alert dedupe key),
                  template_id NULL → recurring_templates (SET NULL), created_at, updated_at
                  VIEWS: live_cards (deleted_at IS NULL), board_cards (live AND archived_at IS NULL)

labels            id PK, name UNIQUE COLLATE NOCASE, color, position
card_labels       card_id → cards, label_id → labels (CASCADE), PK(card_id, label_id)

checklists        id PK, card_id → cards, title, position, created_at
checklist_items   id PK, checklist_id → checklists (CASCADE), text, checked, checked_at NULL,
                  position, created_at

attachments       id PK, card_id → cards, original_name, stored_name (uuid, no extension),
                  mime_type (server-sniffed), kind ('image'|'text'|'file'), size_bytes, sha256, created_at
                  -- file at /data/attachments/<card_id>/<stored_name>

card_links        id PK, from_card_id → cards, to_card_id → cards, type ('relates'|'blocks'), created_at
                  CHECK(from <> to), CHECK(type <> 'relates' OR from < to), UNIQUE(from, to, type)
                  -- 'blocks': from blocks to (to shows "blocked by"); reverse 'blocks' rejected
```

### Activity log (append-only)

```
activity          id PK, card_id → cards, kind ('event'|'worklog'),
                  type  -- created, moved, title_changed, description_changed, labels_changed,
                        -- priority_changed, due_changed, checklist_added, checklist_removed,
                        -- checklist_item_checked, checklist_item_unchecked, attachment_added,
                        -- attachment_removed, linked, unlinked, archived, restored, deleted,
                        -- undeleted, completion_changed, recurrence_skipped, worklog
                  data JSON  -- before/after values with names copied in (column/label names,
                             -- link titles, filenames) so history survives renames/deletes;
                             -- description_changed stores the full old + new text
                  body_md NULL (worklog current text), occurred_at (effective time; backdatable
                  for worklogs), created_at (real insert time), edited_at NULL, retracted_at NULL
                  INDEX (card_id, occurred_at), INDEX (type, occurred_at)

activity_revisions id PK, activity_id → activity, body_md, occurred_at, revised_at
                  -- one row per worklog edit holding the PREVIOUS version → original text kept

Triggers: no DELETE on activity or activity_revisions; no UPDATE on activity_revisions;
UPDATE on activity only for kind='worklog' and only body_md / occurred_at / edited_at / retracted_at.
Migrations temporarily drop/recreate these guard triggers inside their own transaction; there is no
runtime bypass. Restore never deletes rows (it builds a new DB file — see §4).
```

### Recurring maintenance

```
recurring_templates  id PK, title, description_md, priority,
                     checklist_template JSON [{title, items:[text]}],
                     interval_unit ('day'|'week'|'month'), interval_count INT ≥1,
                     start_date (local), next_run_date (local), due_in_days NULL (optional due date
                     on generated cards), enabled (0 = paused), created_at, updated_at
recurring_template_labels  template_id → templates (CASCADE), label_id → labels (CASCADE)
template_runs        id PK, template_id → templates (CASCADE), occurrence_date NULL (NULL = manual
                     "Create now"), outcome ('created'|'skipped_open'|'manual'), card_id NULL, ran_at
                     UNIQUE(template_id, occurrence_date)   -- idempotency: a double tick can't duplicate
```

### Search

```
card_search  FTS5(title, description, checklists, worklogs, history,
                  tokenize='unicode61 remove_diacritics 2'), rowid = cards.id
```
One row per card, rebuilt by `search.reindexCard(tx, cardId)` from the same service calls that write activity
(no triggers). `worklogs` holds non-retracted worklog text; `history` holds useful extra text (old titles,
attachment filenames, linked card titles) — not column/label/priority names, which would make "done" match
every card. One row per card means `parity sdb` finds a card whose title says "parity" and whose worklog says
"sdb". `rebuildSearch()` is used by migrations, restore, and a startup consistency check.

---

## 3. Key behaviors

**Card creation** — one service `cards.create(input, {source, sourceRef?})` used by the UI route, the recurring
scheduler, and the future v2 `POST /api/cards` (bearer token). It accepts label ids or names, defaults to the
triage-role column, writes the `created` event, and reindexes search, all in one transaction.

**All mutations** go through services that run in a transaction and call `activity.record(tx, …)`. Reordering
within a column writes no event. Title/description log once per explicit Save, not per keystroke. Links/unlinks
are logged on both cards. Optimistic concurrency: PATCH sends `expected_version`; a mismatch returns 409 and the
UI shows the newer text (phone vs desktop edits can't silently overwrite each other).

**Ordering** — `POST /api/cards/:id/move {to_column_id, after_card_id|null}`. Anchoring on a card id (not an index)
stays correct while filters hide cards. Server renumbers visible board cards 0..n in one transaction and returns
the new order for both columns. Integer positions; no fractional indexing needed at this scale.

**Due status** — no badge once a card is completed or archived. Date-only due: overdue from the start of the next
local day. With a time: overdue after that instant. Yellow when due within 48 hours.

**Completion** — `completed_at` is set when a card enters the Done column (or is created there), cleared when it
leaves, and editable from card detail ("Completed on …") so you can backdate it; edits are logged.

**Work log** — Markdown body plus an optional backdated time. The client sends wall-clock time; the server
interprets it in the app TZ and rejects anything more than 5 minutes in the future. An edit stores the previous
version in `activity_revisions` and shows "edited <time>" with an expandable history. **Retract** *(default —
override?)* keeps the entry, shown collapsed and struck through, and removes it from the calendar and search.
Nothing is hard-deleted.

**Delete / archive** *(default — override?)* — Delete is a soft delete into a **Trash** view with restore and no
purge in v1. Deleted cards are hidden from the board, calendar and search, but their logs and files are kept.
**Archive** applies to cards in Done. The Archive view offers restore and "Archive all in Done". Archived cards
stay in search and the calendar. Deleting a column requires picking a target column for its cards; role columns
can't be deleted.

**Recurrence** — pure date-only math (`localdate.ts`, epoch-day integers, never JS local `Date`).
- Occurrence k = start + k·N units. Months anchor to the start day with clamping (Jan 31 → Feb 28 → Mar 31, no drift).
- The scheduler ticks at startup, every 10 minutes and when a template is saved. Each due template is handled in
  one transaction:
  1. `occ` = the latest occurrence on or before today.
  2. `INSERT template_runs … ON CONFLICT DO NOTHING`. If the insert does nothing, stop.
  3. If an open instance exists (a live card with this `template_id`, not completed and not archived), record
     `skipped_open` and add a `recurrence_skipped` event to that open card. Otherwise create the card in Triage.
  4. `next_run_date` = the first occurrence after today. After downtime this creates one card, not a burst.
- Resume or edit recomputes `next_run_date` as the first occurrence on or after today.
- *(default — override?)* "Create now" makes a manual run (`occurrence_date NULL`) and leaves the schedule
  unchanged. That card counts as the open instance, and the UI warns if one is already open.
- Seeded templates (all disabled): monthly parity check, monthly SMART review, weekly container/plugin update check.

**Search** — the query is split on whitespace. Tokens with no letters or digits are dropped; each remaining token
becomes a quoted prefix term (`"nginx.conf"*`, `"10.0.0.5"*`, `"sdb1"*`, all verified) and the terms are ANDed.
Ranking uses `bm25` with title weighted highest. Snippets come back with control-character markers that the
client turns into `<mark>` elements as text nodes, never via innerHTML. Archived cards are included; deleted cards
and retracted logs are excluded. Filters: label, priority, column, and date range. *(default — override?)* A card
matches the date range if any of its activity has an effective time inside it.

**Board filter bar** — filters the board payload client-side and keeps its state in the URL. It covers labels,
priority (including "none"), due status (overdue / due ≤48h / has due / no due) and text.

**Calendar** — `GET /api/calendar?from&to` returns three item kinds, bucketed by local day in the app TZ:
due (cards by `due_date`), completed (cards by `completed_at`) and worklogs (by effective `occurred_at`).
Archived cards are included; deleted cards and retracted logs are excluded. Each kind has its own color and
shape: due = ring, completed = check, worklog = pen.
- Month view: a 6×7 grid; desktop cells show 3 items plus "+N more".
- Week view: an agenda list of 7 days.
- Clicking a day opens a list of everything on it. Clicking an item opens `/cards/:id`.

**Attachments** — upload via the file picker, drag and drop, or a pasted screenshot. Paste uses the `paste`
event's `clipboardData.files`, which works over plain HTTP. Pasted screenshots are renamed
`screenshot-YYYYMMDD-HHmmss.png`.
- Upload path: stream to `/data/tmp/<uuid>.part` with `fileSize = MAX_UPLOAD_MB`, then rename into place.
  The client uploads with XHR so it can show progress.
- How files are served:
  - Images (PNG, JPEG, GIF, WebP, detected by magic bytes) are shown inline.
  - Allow-listed text extensions are served as `text/plain`.
  - Everything else is a download.
  - Every response gets nosniff and a sandbox CSP, plus an RFC 5987 `Content-Disposition`.
- Text viewer: `GET /api/attachments/:id/text?mode=head|tail` returns 256 KB. `.log` files open at the tail.
  "Load full" and "Download" are available.
- HEIC photos are download-only.

---

## 4. Backup / export / import

- **Export JSON**: `{schema_version, app_version, app_tz, exported_at, tables: {…rows ordered by id}}`. It
  preserves every primary key and includes activity revisions, template runs and settings (except the password
  hash). Sessions and the FTS index are never exported.
- **Export ZIP**: `data.json` plus `attachments/<card_id>/<uuid>`, streamed directly to the browser.
- **Import (JSON or ZIP)**:
  1. Stream the upload to `/data/tmp`. `MAX_IMPORT_MB` defaults to 2048.
  2. Read the zip with yauzl. Accept only `data.json` and the attachment paths listed in it; enforce size caps
     (zip-bomb protection). Validate with zod (strict id and stored-name formats). Refuse exports from a newer
     schema version than the app.
  3. Build a **new DB file**: migrate it to the export's schema version, insert all rows, migrate to the current
     version, then run `foreign_key_check`, `integrity_check` and the search rebuild.
  4. Preview: counts of cards, logs and attachments, any missing files, and a warning if the TZ differs. To
     confirm, you type `RESTORE`.
  5. Swap: pause the scheduler and return 503; checkpoint and close the DB; move the old DB to
     `/data/backups/pre-restore-<ts>.db` and the old `attachments/` folder alongside it; rename the new DB and
     files into place; reopen.
  6. Your current password hash and sessions carry over, so you stay logged in.
- **Nightly snapshot**: `db.backup()` to `/data/backups/tower-YYYY-MM-DD.db`, keeping 7. A copy of `/data` taken
  while the container is running then still contains a consistent DB.
- **README wording**: copying `/data` with the container stopped is a full backup (Unraid's Appdata Backup
  stops containers by default). For live copies, rely on the snapshots.

---

## 5. Auth & security

- **Password sources**:
  - `APP_PASSWORD` or `APP_PASSWORD_FILE` is authoritative. Changing it revokes all sessions, and the UI's
    change-password form is disabled.
  - Otherwise, first-run setup requires a **one-time code printed to the container log**. Without it, whoever
    reached the app first could claim it, which is the exact proxy-misconfiguration risk.
  - The setup write is race-safe (`INSERT … ON CONFLICT DO NOTHING`). Minimum length is 12 characters.
  - Changing the password in the UI requires the current password and revokes all other sessions.
- **Session cookie** `tt_sid`: HttpOnly, SameSite=Lax, Path=/, with `Secure` added automatically on HTTPS requests.
  - "Remember this device" gives a 90-day sliding expiry; otherwise it's a browser-session cookie with a 12-hour
    idle timeout.
  - `last_seen_at` is written at most every 10 minutes.
- **Login rate limit**:
  - Per IP: 5 failures locks that IP for 15 minutes.
  - Global: a soft slowdown, never a hard lockout, so an attacker can't lock you out from the LAN.
  - Checked before hashing.
- **TRUST_PROXY** takes only an IP or CIDR list (e.g. your NPM VM's IP). `true` is rejected because it would let
  anyone spoof `X-Forwarded-For`.
- **CSRF**: every cookie-authenticated, non-GET `/api` request needs the `X-Requested-With` header and an `Origin`
  host matching `Host`. Bearer-token requests (v2) skip this check.
- **Headers**:
  - CSP: `default-src 'self'; img-src 'self' blob: data:; object-src 'none'; base-uri 'none'; form-action 'self';
    frame-ancestors 'none'`.
  - Also nosniff, `Referrer-Policy: no-referrer`, and `X-Frame-Options: DENY`.
  - No HSTS. `/api` responses use `no-store`; hashed assets are cached as immutable.
- **`/health`**: no auth, not logged. Runs `SELECT 1` and checks that `/data` is writable; returns 200 or 503.

---

## 6. Container & ops

- **Multi-stage Dockerfile** on `node:24-bookworm-slim`; dependencies installed with `npm ci`. It includes a
  `HEALTHCHECK` (Node `fetch` to `127.0.0.1:$PORT/health` with a timeout; no curl needed).
- **`docker/entrypoint.sh`**:
  - Validates PUID/PGID and applies `UMASK` (0002).
  - Creates `/data/{attachments,backups,tmp}`.
  - Chowns only files whose ownership is wrong.
  - Then `exec setpriv --reuid --regid --clear-groups --no-new-privs node …`. It also works if started with `--user`.
- **SIGTERM**: stop the scheduler, close Fastify, checkpoint the WAL, close the DB. Compose uses `init: true` and
  `stop_grace_period: 30s`.
- **Startup**:
  - Validate TZ (exit with a clear message if it's invalid).
  - Run `PRAGMA quick_check`, then migrations, then seed defaults once (`settings.seeded`).
  - Sweep `/data/tmp`.
- **Stale bundles**: `index.html` is served `no-cache`. A `vite:preloadError` triggers one reload, and a version
  banner appears after an update. No service worker, because the app runs over plain HTTP. A web manifest and
  icons still make "Add to Home Screen" work.
- **Build guard**: the build fails if any `http(s)://` asset URL ends up in `dist/` (enforces the no-CDN rule).

### Environment variables

| Var | Default | Notes |
|---|---|---|
| `PORT` | 8080 | |
| `TZ` | America/Chicago | validated at boot |
| `APP_PASSWORD` / `APP_PASSWORD_FILE` | — | optional; authoritative when set |
| `MAX_UPLOAD_MB` | 25 | per attachment |
| `MAX_IMPORT_MB` | 2048 | restore uploads |
| `PUID` / `PGID` / `UMASK` | 99 / 100 / 0002 | |
| `TRUST_PROXY` | (unset) | IP/CIDR list of your reverse proxy |
| `COOKIE_SECURE` | auto | auto / true / false |
| `SESSION_DAYS` | 90 | "remember this device" lifetime |
| `LOG_LEVEL` | info | |

---

## 7. Frontend & mobile

- **Card detail** is a route, `/cards/:id`, rendered over the current page.
  - Desktop (≥768px) shows it as a modal; narrower screens show a full-screen sheet. It is the same component,
    switched by CSS.
  - Back and Esc close only the topmost layer; a discard prompt appears if there are unsaved edits.
  - Calendar and search items deep-link to it.
- **Board on mobile**:
  - Columns are `min(85vw, 320px)` wide with scroll-snap, so the next column peeks in.
  - A sticky bar shows column names with counts. Filters collapse into a "Filters (n)" sheet.
  - Touch targets are at least 44px; inputs use a 16px font so iOS doesn't zoom.
- **Moving cards**:
  - Every tile and the card header have **Move to…**: a bottom sheet with the columns, Top/Bottom, and
    one-tap "Mark done".
  - Long-press (250 ms) starts a drag on touch, while a swipe still scrolls. Scroll-snap is off during a drag.
  - Drag uses a `DragOverlay` and droppable empty columns.
- **Logging work on the phone**:
  - A sticky **Log work** button opens a bottom-sheet composer.
  - Quick time chips: Now, 1h ago, This morning, Yesterday, Custom.
  - "Attach photo" uploads and embeds the image.
  - Drafts autosave to `localStorage`, so an expired session or an accidental Back doesn't lose your note.
- **Plain-HTTP safety**: no `crypto.randomUUID` or `navigator.clipboard` (both unavailable over plain HTTP on
  Tailscale), enforced by a lint rule.
- **Keyboard**: `n` new card in Triage, `/` search, `Esc` close. Ignored while typing or dragging.
- **Theme**: dark with `color-scheme: dark`, so native date pickers and selects are dark too.
- **Code splitting**: the board loads eagerly; card detail, calendar, search, templates and settings are
  lazy-loaded.

---

## 8. Project structure (npm workspaces)

```
tower-tracker/
├─ Dockerfile, docker-compose.yml, .dockerignore, README.md, package.json, package-lock.json
├─ docker/entrypoint.sh
├─ docs/DESIGN.md
├─ shared/src/                         # zod schemas + types (api contracts, enums)
├─ server/
│  ├─ src/
│  │  ├─ index.ts                      # bootstrap, signals, scheduler start
│  │  ├─ app.ts                        # Fastify instance builder (used by tests)
│  │  ├─ config.ts                     # env parsing/validation
│  │  ├─ clock.ts                      # injectable clock
│  │  ├─ db/ connection.ts, migrate.ts, guards.sql, migrations/NNN_*.sql, seed.ts
│  │  ├─ auth/ password.ts, sessions.ts, rateLimit.ts, guard.ts, csrf.ts
│  │  ├─ services/ cards, columns, labels, checklists, attachments, links, activity,
│  │  │            worklog, search, recurring, calendar, backup, snapshot
│  │  ├─ routes/ auth, board, cards, columns, labels, checklists, attachments, links,
│  │  │          activity, search, calendar, templates, backup, health, config
│  │  ├─ lib/ localdate.ts, time.ts, recurrence.ts, ftsQuery.ts, sniff.ts
│  │  └─ scheduler.ts
│  └─ test/ activity, recurrence, search, backup (round-trip), auth, routes
└─ web/
   ├─ index.html, vite.config.ts, public/ (manifest, icons)
   └─ src/ main.tsx, App.tsx, api/ (client + query hooks), lib/ (time, uid, layers, drafts),
          components/ board/ card/ calendar/ search/ templates/ archive/ settings/ common/, styles/
```

---

## 9. Phases (each ends with a Docker smoke check)

Smoke check after every phase: `docker compose up -d --build` → `/health` is 200 → log in → create a card →
`docker compose up -d --force-recreate` → the card and its log are still there.

1. **Phase 1**
   - Infrastructure: container, entrypoint, PUID/PGID, health check, migrations, auth (setup code, sessions,
     rate limit).
   - Board: columns (add, rename, reorder, delete with a target column) and labels, with defaults seeded.
   - Cards: create, edit title, soft delete; drag and drop on mouse and touch; **Move to…**.
   - The activity tables, triggers and event recording **start here** (the UI comes in Phase 2), so cards you
     create during Phase 1 already have a history.
2. **Phase 2**
   - Card detail route (modal or full-screen) with Markdown description.
   - Checklists, priority, due date and time, editable completion, attachments (picker, drop, paste, text viewer)
     and links.
   - Activity log UI, work log with backdating, edit history and retract.
   - Archive and Trash views.
3. **Phase 3**
   - Calendar (month and week).
   - FTS search (built from existing data) plus the board filter bar.
   - Recurring templates page and scheduler, with the seeded templates.
4. **Phase 4**
   - Export (JSON and ZIP), import/restore, nightly snapshots.
   - Mobile polish pass.
   - README: setup, env vars, Unraid via the Compose Manager plugin, backup/restore, Tailscale, NPM proxy host
     (Access List, body size), and checking Exclusive access.

### Tests (core logic)

- **activity**
  - Each mutation writes exactly one correctly shaped event, with names copied in.
  - A reorder writes nothing.
  - DELETE or UPDATE on the log is rejected.
  - A worklog edit stores a revision; retract keeps the row.
- **recurrence**
  - Jan 31 monthly clamping; Feb 29 yearly-ish; quarterly from the 30th.
  - Daily and weekly schedules across both 2026 DST changes.
  - 3 weeks of downtime → exactly one card.
  - **No duplicate while open**; a new card once the previous one is done, archived or deleted.
  - Pause/resume; Create-now then a tick; a double tick → one card.
  - Run under two TZs.
- **search**
  - Terms split across title and worklog.
  - IPs, filenames, `sdb1`; punctuation-only tokens.
  - Archived included, deleted excluded; index stays in sync after edits.
  - Each filter.
  - Snippet XSS test.
- **backup**
  - Export → restore into a fresh file DB → export again gives identical data (except `exported_at`).
  - Attachment hashes match; search works after restore.
  - Old schema version migrates.
  - Malicious or oversized zip is rejected and the live DB is untouched.

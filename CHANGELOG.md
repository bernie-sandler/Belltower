# Changelog

Versions follow [semver](https://semver.org). From 1.0 on, upgrades within 1.x never break your data, backups or
automation (see [docs/UPGRADING.md](docs/UPGRADING.md#what-10-promises)). The version is shown in **Settings**, in
the container log on start, and in every backup export.

## 1.2.2: The real icon in the app

- **The top bar and sign-in page show the real Belltower icon.** They were drawing a plain bell in code, so they didn't
  match the Home Screen icon. They now use the same picture, the bell in its tower, from the app's icon files.

## 1.2.1: Compose file uses the new image

The app itself hasn't changed. This release makes the files that ship with a release match the new image address.

- **The right image out of the box.** `docker-compose.yml` now uses `ghcr.io/bernie-sandler/belltower`. The copy in the
  1.2.0 release still named the old address.
- **Older versions are retired.** Images now go back to 1.2.0, and `ghcr.io/bernie-sandler/tower-tracker` and the
  earlier releases are going away. If `TT_VERSION` is set to `rc`, `beta` or anything before 1.2.0, change it to
  `latest`. Your data is safe either way: 1.2.1 reads every older database and backup.

## 1.2.0: Tower Tracker is now Belltower

- **New name, new look.** The app is now Belltower, with a new logo and icons. That covers the top bar, sign-in page,
  browser tab, Home Screen app, Discord messages, backup file names, the Docker container and the docs.
- **Your data stays put.** The database, backups, API tokens, sign-ins and the automation API (`/api/v1`) are
  unchanged. Backups made under the old name restore as usual, and saved import prompts still work.
- **One manual step for existing installs.** The Docker container and stack have a new name, so stop the old one
  first and keep your `DATA_PATH`. See
  [Coming from Tower Tracker](docs/UPGRADING.md#coming-from-tower-tracker).
- **New image address.** The repository is now `bernie-sandler/Belltower` and the image is
  `ghcr.io/bernie-sandler/belltower`. `docker-compose.yml` and the Unraid template point there. Versions before 1.2.0
  stay at `ghcr.io/bernie-sandler/tower-tracker`, so if `TT_VERSION` is set to one of those, or to `rc` or `beta`,
  change it to `latest`.

## 1.1.0: Drag whole folders

- **Move a folder in one go.** Tickets whose work card is in another column sit under a folder header. Drag that
  header to another column and all its tickets go with it: with the mouse, a long press on a phone, or `Space` and
  the left and right arrow keys. A click still folds it, and a folded folder brings its hidden tickets along.
- **All or nothing.** A folder moves as one step, so a failure can't leave it split between columns. If a ticket is
  blocked, or went to the Trash on another device, nothing moves and a message names the ticket.
- **Nothing to do when upgrading.** The database, backups and the automation API (`/api/v1`) are unchanged. The web
  app gets one new route of its own, `POST /api/cards/move-many`.

## 1.0.0: Stable

1.0 adds no new features. It's 0.10 made trustworthy for the long run, and it ran as a release candidate on a real
server first.

- **Promises from here on:** every 1.x reads every older database and backup; database changes only add; the
  automation API (`/api/v1`) is frozen; breaking changes wait for 2.0.
- **Upgrade tested.** Every older schema is now tested on every build, both upgraded in place and restored from a
  backup. Before release, real data from 0.5, 0.6, 0.7, 0.9 and 0.10 was upgraded and restored into 1.0, along with
  real snapshots.
- **Faster boards when Done grows.** The Done column shows the 50 most recently finished cards, with **Show N
  older cards** for the rest. A board with 1,900 finished cards went from about 50,000 page elements to 5,000, and
  renders roughly eight times faster.
- **Contrast.** Secondary text in the dark theme is a little lighter, so every screen passes the 4.5:1 contrast
  check in both themes.
- **Documentation rewritten.** The README is now a short overview. Each topic has its own page under `docs/`
  (install, upgrading, using it, remote access, backups, submit page, notifications, automation, Claude drafting),
  plus two frozen specs: the [automation API](docs/API-V1.md) and the [backup format](docs/BACKUP-FORMAT.md).
- **Stable by default.** `docker-compose.yml` and `.env.example` now use `latest`. If your `.env` says `beta` or
  `rc`, change it to `latest`, because neither of those follows 1.0. See
  [docs/UPGRADING.md](docs/UPGRADING.md#moving-from-a-beta-to-10).
- **More ways to set it up on Unraid.** There's now a template for Unraid's **Add Container** form
  ([docs/INSTALL.md](docs/INSTALL.md)), and step-by-step setup for turning Unraid's alerts into tickets
  ([docs/AUTOMATION.md](docs/AUTOMATION.md)).
- **MIT license.** See [LICENSE](LICENSE).
- **For developers:** `npm run seed:perf -w @tt/server -- <folder>` creates a 2,000-card board and times it; new
  tests cover keyboard moves with screen-reader announcements and the `/api/v1` contract.

**Known gap:** Claude drafting is tested against a stand-in for Claude, but hasn't been run against the live API yet.
It's optional and stays off without an API key. If a draft fails, the dialog says so and you can fill the ticket in
by hand.

## 0.10.0: Resolutions, light theme, smarter Claude (beta)

- **Resolution notes.** **Mark done** opens a quick dialog: how it was resolved (Fixed, Won't fix, Duplicate,
  Can't reproduce, No longer needed) and an optional note. The first reason is preselected and Enter accepts.
  - Dragging a card into Done (or Move to → Done) shows a toast with **Add resolution**.
  - Done cards show a **Resolution** section, editable any time. Reopening a card clears it; the history keeps
    every version.
  - Tiles show a badge when the reason isn't the default ("Won't fix", "Duplicate"…).
  - Resolution notes are searchable ("how did I fix this last time?").
  - The reasons are an editable list in **Settings → Resolution reasons**; the first is the default.
  - Automation recoveries that complete a ticket record the default reason with a "Recovered" note.
  - Card import accepts `resolution` and `resolutionNote` for cards created in Done.
- **Light theme.** Follows your device's light/dark setting by default. **Settings → Appearance** picks Light,
  Dark or System, remembered per device.
- **Claude drafting knows your board.**
  - A draft now suggests the card type (ticket or work card), an open work card to file it under, and links to
    open cards it blocks, waits on or relates to, each with a reason. All of it shows in the review form and can be
    changed or removed.
  - New **Add ticket → Describe several issues**: paste notes, a to-do list or logs, and Claude splits them into
    cards (grouping steps under a work card, with links between them). You review the same preview as an import,
    then create them all at once. Counts as one draft.
  - Drafts now also send your open cards' titles (up to 100) to Anthropic, so Claude can refer to them.
- Database schema 6 (`cards.resolution`, `cards.resolution_md`).

## 0.9.0: Tickets from other people and services (beta)

- **Settings page** (Menu → Settings):
  - ticket number format (e.g. `TT-{YYYY}{MM}{DD}-{N}`);
  - the app's address;
  - Claude model;
  - blocked column;
  - submit page, automation tokens, Discord, password.
- **Submit page.** A shareable link (`/submit/<key>`) where people without your password file tickets. They pick a
  request type and answer its questions; the answers are appended to their description, and the title follows the
  type's pattern ("Plex – {title} – {summary}"). Also tags you allow, up to 3 screenshots, and their name.
  - Starts with **General**, **Plex** and **Game servers**, based on your Discord support templates.
  - Request types and their questions (short or long text, pick one or several, date and time, yes/no) are
    editable in Settings.
  - Rate limited, image-only screenshots, a bot trap, and a new link at any time.
- **Automation.** API tokens and `POST /api/v1/cards`, with `dedupeKey` (repeat alerts add a note to the open
  ticket) and `"event": "resolved"` (notes the recovery, and can mark it done). Includes an Uptime Kuma webhook
  (`/api/v1/hooks/uptime-kuma`). Recipes in `docs/AUTOMATION.md`.
- **Discord notifications** through a webhook:
  - new tickets from the submit page or automation;
  - blocked cards;
  - a daily summary of overdue and due-today cards;
  - urgent cards: created urgent or raised to urgent later. "Urgent" defaults to P0–P1 or S1 and can be changed;
  - a **Send test** button, **Send summary now**, and the last delivery result.
- Database schema 5 (`request_types`, `api_tokens`), included in backups.

## 0.8.0: Hardening (beta)

No new features; this release is about upgrading and releasing safely.

- **Safer upgrades.** Before the database is upgraded, the app saves a copy of it in `/data/backups`
  (`pre-migrate-v<old>-to-v<new>-….db`, last 5 kept). If the copy can't be written, nothing is changed and the
  container stops with an error explaining why.
- **Prebuilt images.** Tagged releases are published to `ghcr.io/bernie-sandler/tower-tracker` by GitHub
  Actions. `docker-compose.yml` now pulls the image (`TT_VERSION` in `.env`, default `beta`); building from source
  is still possible with `docker-compose.build.yml`. Updating is `docker compose pull && docker compose up -d`.
- **Tests.** Web unit tests (board grouping, filters, the Add ticket form, history text, Mark done dialog) and
  end-to-end tests in Chrome at desktop and iPhone sizes (login, cards, dragging, blocked cards, links, work
  cards, import, backup and restore, search). GitHub Actions runs everything on every push, plus a Docker build
  and health check.
- **Security.** Updated zod, fastify and fast-uri for published advisories (`npm audit` is clean). Dependabot
  opens weekly update PRs. New `SECURITY.md`.
- Fixed: after **Add item** in the Add ticket checklist, the first letters typed could be lost.
- The link picker and the work-card picker are now one component.

## 0.7.0: Work cards

- Two card types: **tickets** (an issue or finding) and **work cards** (what you're actually working on). Work
  cards have a purple accent and a "Work 2/3" badge counting their finished tickets. Switch type in the card.
- File tickets under a work card (**Part of** in the ticket, or **Add ticket here** / **File a ticket…** in the
  work card). One level only; a work card can't be part of another card.
- On the board, a work card's tickets stack together in every column, indented under the work card, or under a
  "▾ 261027-1 Plex upgrade" header when the work card is in another column. Groups collapse; that's
  remembered per browser.
- **Mark done** on a work card with open tickets asks: **Complete with N tickets** or **Only this card**. All or
  nothing: if any ticket is blocked by an open card outside the group, nothing moves and the stuck tickets are
  listed. Dragging a work card into Done offers to complete its tickets from the toast.
- A trashed or archived work card stops grouping its tickets until it's restored.
- Board filter **Type** (Work cards / Tickets). Add ticket has Type and Part of fields.
- Card import: `"type": "work"`, nested `"tickets": [...]`, and `"partOf"` (a ticket number, or a `"ref"`/title
  in the same import). The preview shows the tree, and **Copy AI prompt** lists your open work cards.
- Card import links: `"blocks"`, `"blockedBy"` and `"relatedTo"` by ticket number or by `"ref"`/title within the
  import. Same rules as links made by hand (blocked cards move to Blocked/Waiting; no blocking a done card).
- API: `kind`/`parentId` on cards, `POST /api/cards/:id/complete`, `GET /api/cards?kind=`. Database schema 4.

## 0.6.0: Ticket numbers

- Every card gets a ticket number when it's created, shown with its title as **"261024-1 — Title"** on the board,
  in the card, in links, search, the calendar, Archive and Trash.
- The format is `YYMMDD-N`: the local creation date (app time zone) and a counter that starts at 1 each day.
  Numbers never change when the title is edited and are never reused.
- Existing cards are numbered by their creation date on the first start of 0.6.0 (and when restoring an older
  backup).
- Search and the link picker find cards by ticket number.
- Database schema 3 (`cards.ticket_no`).

## 0.5.1: Blocking links are enforced

- A card that's **blocked by** open cards can't be completed: moving it into Done (drag and drop, Move to…,
  Mark done, or deleting its column into Done) is refused with the names of the open blockers (`409 blocked`).
  It can still move between other columns.
- A blocker counts as finished once it's done (or archived after being done); blockers in the Trash are ignored.
- An open card can't be added as a blocker of a card that's already done.
- When a card becomes blocked (linked as "blocked by" an open card, or a blocker is reopened or restored from
  the Trash), it moves to the **Blocked/Waiting** column automatically, and its history says which cards block
  it. Choose a different column, or turn this off, with **Move blocked cards here** in a column's menu. The
  blocked column shows a ⊘ icon. Done cards and cards already in that column don't move.
- Blocked cards show a **Blocked** badge on the board, and the card's Linked cards section says what it's waiting
  on. Cards and the board refresh when a blocker is finished, reopened, trashed or restored.

## 0.5.0: Add ticket with Claude drafting

- **Add ticket** button in the top bar (`Shift+N`).
  - **Describe the issue**: Claude drafts the ticket (title, Markdown details, priority from impact × urgency,
    severity, labels, checklist) for you to review before it's created.
  - **Blank ticket**: the same form, filled in by hand.
- Optional `ANTHROPIC_API_KEY` (and `ANTHROPIC_MODEL`, default `claude-opus-5-5`). Without a key the app stays
  fully offline and Add ticket offers the paste-JSON import instead.
- New API: `GET /api/ai/status`, `POST /api/ai/draft`, `POST /api/tickets`.

## 0.4.0: Backup & restore, card import (tag `alpha-phase-4`)

- Export to JSON or ZIP (with attachments), staged restore with preview and `RESTORE` confirmation.
- Nightly database snapshots (last 7 kept).
- AI-friendly card import (`tower-tracker/cards@1`).
- Full README.

## 0.3.0: Calendar, search, recurring maintenance (tag `alpha-phase-3`)

- Month and week calendar.
- Full-text search, including archived cards.
- Board filters.
- Recurring maintenance templates.

## 0.2.0: Card detail (tag `alpha-phase-2`)

- Markdown descriptions, checklists, attachments, links between cards.
- Work log with backdating and edit history.
- Archive and Trash.
- Priority P0–P3 and severity S1–S4.

## 0.1.0: First release

- Docker container, password auth, board with columns, cards, drag and drop, labels.

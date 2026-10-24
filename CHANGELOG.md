# Changelog

Versions follow [semver](https://semver.org). While the app is in alpha (0.x), each minor version is a feature
release. The version is shown in **Settings**, in the container log on start, and in every backup export.

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

# Changelog

Versions follow [semver](https://semver.org). While the app is in alpha (0.x), each minor version is a feature
release. The version is shown in **Settings**, in the container log on start, and in every backup export.

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

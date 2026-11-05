<p align="center">
  <img src="web/public/favicon.svg" alt="Tower Tracker logo" width="120" height="120">
</p>

<h1 align="center">Tower Tracker</h1>

<p align="center">
  <a href="https://github.com/bernie-sandler/tower-tracker/releases"><img alt="Release" src="https://img.shields.io/github/v/release/bernie-sandler/tower-tracker?include_prereleases&sort=semver"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

<p align="center">
  <img alt="Built with TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white">
  <img alt="Built with React" src="https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB">
  <img alt="Built with Fastify" src="https://img.shields.io/badge/Fastify-000000?logo=fastify&logoColor=white">
  <img alt="Built with SQLite" src="https://img.shields.io/badge/SQLite-003B57?logo=sqlite&logoColor=white">
  <img alt="Built with Docker" src="https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white">
</p>

A small, self-hosted issue tracker for a homelab. Think of it as a Trello board that remembers everything: when the
parity check started throwing errors, what you tried, which cable you swapped, and how it finally got fixed.

It's built for one person running one server. It's a single Docker container with a SQLite database, it keeps
everything in one folder, and it works fine with no internet connection.

## What it does

- **A board you already know how to use.** Triage → Backlog → In Progress → Blocked/Waiting → Done. Drag cards
  around with a mouse, a finger or the keyboard.
- **Cards with real detail.** Ticket numbers (`261024-1`), Markdown notes, labels, priority and severity, due
  dates, checklists, and attachments: paste a screenshot, drop in a log file.
- **Links and blockers.** Say one card is waiting on another and it moves to Blocked/Waiting by itself, and can't be
  closed until the blocker is done.
- **Work cards.** Group related tickets under one piece of work, like a folder, and finish them all at once.
- **A history you can trust.** Every change is recorded and can't be edited or deleted. A work log holds your own
  notes ("swapped the SATA cable on drive 3"), and closing a card records how it was resolved.
- **Find it again later.** Full-text search over everything, a calendar of what was due and what got done, and
  recurring maintenance cards (the monthly parity check) that show up on schedule.
- **Tickets from elsewhere.** A shareable page where family or friends can report problems without your password,
  plus API tokens so Uptime Kuma, Unraid or Home Assistant can open tickets when something breaks.
- **Discord alerts** for urgent cards, new outside tickets and a daily summary.
- **Backups built in.** Nightly snapshots, one-click export, and a restore that shows you what you're about to get.
- **Optional Claude drafting.** Describe a problem in plain words and get a well-formed ticket back. Off unless you
  add an API key.
- **Light and dark**, and it works well on a phone.

## Quick start (Unraid)

1. Clone this repository somewhere outside your data folder, for example
   `/mnt/user/appdata/tower-tracker-src`.
2. Copy `.env.example` to `.env`. The defaults are fine for most setups.
3. In **Docker → Compose**, add a stack pointing at that folder and press **Compose Up** (or run
   `docker compose up -d`).
4. Open `http://tower:8080`.
5. Grab the one-time setup code from the container log and choose a password.

The full walkthrough (private image access, where the data should live, every setting) is in
[docs/INSTALL.md](docs/INSTALL.md).

## Documentation

| | |
|---|---|
| [Install and configure](docs/INSTALL.md) | Setting it up on Unraid, `.env` settings, troubleshooting |
| [Upgrading](docs/UPGRADING.md) | Updating, moving from a beta to 1.0, rolling back |
| [Using Tower Tracker](docs/USING.md) | A tour of the board, cards, work cards, history, search and settings |
| [Phone and remote access](docs/REMOTE-ACCESS.md) | Tailscale, Nginx Proxy Manager, the Home Screen app |
| [Backups](docs/BACKUP.md) | Snapshots, export and restore, moving to a new server |
| [Submit page](docs/SUBMIT-PAGE.md) | Letting other people file tickets |
| [Discord notifications](docs/NOTIFICATIONS.md) | What gets announced and how to set it up |
| [Automation](docs/AUTOMATION.md) | Uptime Kuma, Unraid, Home Assistant and scripts |
| [Claude drafting](docs/AI-DRAFTING.md) | Turning a description into tickets, cost and privacy |
| [Card import format](docs/CARD-IMPORT.md) | Creating cards from JSON (handy with any AI chat) |
| [Automation API (v1)](docs/API-V1.md) | The stable API contract for tools and scripts |
| [Backup file format](docs/BACKUP-FORMAT.md) | What's inside an export |
| [Development](docs/DEVELOPMENT.md) | Building, testing and releasing |
| [Security](SECURITY.md) | What the app protects and what's up to you |
| [Changelog](CHANGELOG.md) | What changed in each version |

## Versions

Tagged releases are published as images at `ghcr.io/bernie-sandler/tower-tracker`. Pick a channel with
`TT_VERSION` in `.env`: `latest` for stable releases, `rc` for release candidates, `beta` for betas, or an exact
version like `1.0.0`. Updating is `docker compose pull && docker compose up -d`; the database upgrades itself
after saving a copy. See [docs/UPGRADING.md](docs/UPGRADING.md).

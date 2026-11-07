<p align="center">
  <img src="assets/belltower-logo.svg" alt="Belltower logo" width="120">
</p>

<h1 align="center">Belltower</h1>

<p align="center">
  <strong>Self-hosted ticketing for homelabs and small teams.</strong><br>
  <em>Ring the bell when something breaks.</em>
</p>

<p align="center">
  <a href="https://github.com/bernie-sandler/Belltower/releases"><img alt="Release" src="https://img.shields.io/github/v/release/bernie-sandler/Belltower?include_prereleases&sort=semver"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

<p align="center">
  <img alt="Built with TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white">
  <img alt="Built with React" src="https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB">
  <img alt="Built with Fastify" src="https://img.shields.io/badge/Fastify-000000?logo=fastify&logoColor=white">
  <img alt="Built with SQLite" src="https://img.shields.io/badge/SQLite-003B57?logo=sqlite&logoColor=white">
  <img alt="Built with Docker" src="https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white">
</p>

---

Belltower is a lightweight ticket tracker for the people who keep things running: whoever runs the home server, the small-office IT person, the friend everyone texts when Plex goes down. Users ring the bell when something's wrong, and you track it, fix it, and keep a record of what you did and when.

It's built for small setups where a full help desk is overkill and a sticky note isn't enough.

## Features

- **Ring the bell:** a simple page where users can submit a ticket
- **Board view:** a Trello-style board for moving tickets from open to done
- **Labels:** tag tickets by area, like Network, Storage, or Docker
- **History:** every ticket keeps a record of what was done and when
- **JSON import:** bring in existing tickets in bulk
- **Self-hosted:** runs on your own server, so your data stays with you

<!-- Add a screenshot here once the UI settles:
![Belltower board](assets/screenshot-board.png)
-->

## Status

Belltower is in early development. Expect rough edges and breaking changes.

## Quick start (Unraid)

1. Clone this repository somewhere outside your data folder, for example
   `/mnt/user/appdata/belltower-src`.
2. Copy `.env.example` to `.env`. The defaults are fine for most setups.
3. In **Docker → Compose**, add a stack pointing at that folder and press **Compose Up** (or run
   `docker compose up -d`).
4. Open `http://tower:8080`.
5. Grab the one-time setup code from the container log and choose a password.

The full walkthrough (where the data should live, every setting) is in
[docs/INSTALL.md](docs/INSTALL.md).

## Documentation

| | |
|---|---|
| [Install and configure](docs/INSTALL.md) | Setting it up on Unraid, `.env` settings, troubleshooting |
| [Upgrading](docs/UPGRADING.md) | Updating, coming from Tower Tracker, moving from a beta to 1.0, rolling back |
| [Using Belltower](docs/USING.md) | A tour of the board, cards, work cards, history, search and settings |
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

Tagged releases are published as images at `ghcr.io/bernie-sandler/belltower`. Pick a version with `TT_VERSION` in
`.env`: `latest` for stable releases, or an exact version like `1.2.0`. Updating is
`docker compose pull && docker compose up -d`; the database upgrades itself after saving a copy. See
[docs/UPGRADING.md](docs/UPGRADING.md).

Belltower was called Tower Tracker before 1.2. Coming from that name? See
[Coming from Tower Tracker](docs/UPGRADING.md#coming-from-tower-tracker).

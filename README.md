# Tower Tracker

A self-hosted, single-user, Trello-style issue tracker for a homelab. One Docker container with SQLite.
Everything it stores lives under `/data`.

> **Status: Phase 3 of 4.** Working now:
> - the board, columns, cards, labels, drag and drop, "Move to…" and the filter bar
> - card details (Markdown, priority P0–P3, severity S1–S4, due dates, checklists, attachments, links)
> - the activity log and work log, Archive and Trash
> - the calendar, full-text search, and recurring maintenance templates
>
> Coming next: backup/restore, a mobile polish pass and the full guide (Phase 4).
> The design is in [docs/DESIGN.md](docs/DESIGN.md) and the API in [docs/API.md](docs/API.md).

## Run it on Unraid (Docker Compose Manager)

1. Copy this folder to the server, for example `/mnt/user/appdata/tower-tracker-src`. Keep it out of the
   data folder.
2. Copy `.env.example` to `.env` in the same folder and adjust it (port, data path, time zone, …).
3. In **Docker → Compose**, add a stack whose compose file is this repo's `docker-compose.yml`, then
   **Compose Up**. Or from a terminal in that folder:
   ```bash
   docker compose up -d --build
   ```
4. Open `http://tower:8080` (or the `PORT` you chose). On the first run the app asks for a one-time
   **setup code**. Find it in the container log (Docker tab → tower-tracker → Logs, or
   `docker logs tower-tracker`), then choose a password (12+ characters).

Data is stored in `DATA_PATH` (default `/mnt/cache/appdata/tower-tracker`): the DB and attachments. This is
the pool path for the appdata share. It avoids Unraid's user-share layer, which matters for SQLite while
"Permit exclusive shares" is off. If your pool isn't called `cache`, change `DATA_PATH` in `.env`.

## Try it on a desktop

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
```

## Configuration

Settings live in **`.env`**, next to `docker-compose.yml` (start from `.env.example`). Docker Compose reads it
automatically. After changing it, apply the change with:

```bash
docker compose up -d
```

Compose recreates the container with the new settings; your data is untouched. Don't edit the numbers in
`docker-compose.yml` itself: they only supply the defaults.

| Variable | Default | |
|---|---|---|
| `PORT` | `8080` | The port you open the app on. It is used both on Unraid and inside the container, so one setting changes both. |
| `DATA_PATH` | `/mnt/cache/appdata/tower-tracker` | Host folder for the database and attachments. |
| `TZ` | `America/Chicago` | All dates and times are shown in this zone. |
| `APP_PASSWORD` | — | Optional. When set, this is the password, and changing it in the app is disabled. Single-quote it if it contains `$`. |
| `MAX_UPLOAD_MB` | `25` | Largest allowed attachment. If Nginx Proxy Manager proxies the app, raise its `client_max_body_size` to match. |
| `PUID` / `PGID` | `99` / `100` | Ownership of files in `DATA_PATH`. |
| `TRUST_PROXY` | — | Only if Nginx Proxy Manager proxies the app: the NPM VM's LAN IP. |

Advanced settings the app also understands (add them to `environment:` in the compose file if you need them):
`APP_PASSWORD_FILE`, `UMASK` (`0002`), `COOKIE_SECURE` (`auto`: Secure flag on HTTPS requests),
`SESSION_DAYS` (`90`: how long "Remember this device" lasts), `LOG_LEVEL` (`info`).

A variable set in the shell you run `docker compose` from takes precedence over `.env`. This matters only if
your shell already exports one of these names, such as `TZ`.

## Development

```bash
npm install
npm run dev:server
```

In a second terminal, start the UI with hot reload (it proxies `/api` to the server):

```bash
npm run dev:web
```

Run the server tests:

```bash
npm test
```

Typecheck everything:

```bash
npm run typecheck
```

Build the production bundles:

```bash
npm run build
```

In development the server keeps its data in `server/data/`. Set `DATA_DIR` to put it somewhere else.

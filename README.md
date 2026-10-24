# Tower Tracker

A self-hosted, single-user, Trello-style issue tracker for a homelab. It's for triaging and fixing problems, and it
keeps a record of what you did and when. It runs as one Docker container with SQLite, keeps everything under `/data`,
and needs no internet.

- **Board**:
  - Triage → Backlog → In Progress → Blocked/Waiting → Done; columns can be renamed, added and reordered.
  - Move cards by drag and drop (mouse, long-press on a phone, or keyboard) or with **Move to…**.
  - Filter by label, priority, severity, due status and text.
- **Cards**:
  - A Markdown description, labels, priority (P0–P3, with an impact × urgency helper), severity (S1–S4), and a due
    date with an optional time.
  - Checklists, plus attachments: drag and drop, pasted screenshots, inline images, and a log viewer.
  - Links between cards ("related to", "blocks / blocked by").
- **History**:
  - Every change is recorded automatically and can't be altered or deleted.
  - A **work log** for notes like "Swapped SATA power cable to drive 3", with backdating and edit history.
- **Calendar**: month and week views of what was due, what got done, and what work was logged.
- **Search**: full-text across titles, descriptions, checklists and work logs, archived cards included.
- **Recurring maintenance**: templates (e.g. a monthly parity check) that create a Triage card on a schedule, never
  duplicating an open one.
- **Archive and Trash**: archived cards stay searchable; deleted cards can be restored, and nothing is ever purged.
- **Backup & restore**:
  - Export to JSON or ZIP (with attachments) and restore with a preview.
  - Plus nightly snapshots.
- **Card import**: paste JSON written by an AI to create ready-made cards. See [docs/CARD-IMPORT.md](docs/CARD-IMPORT.md).

The design is in [docs/DESIGN.md](docs/DESIGN.md) and the HTTP API in [docs/API.md](docs/API.md).

---

## Install on Unraid (Docker Compose Manager)

1. **Get the code onto the server.** For example, clone the repo to `/mnt/user/appdata/tower-tracker-src`. Keep it
   outside the data folder.
   ```bash
   git clone https://github.com/bernie-sandler/tower-tracker.git /mnt/user/appdata/tower-tracker-src
   ```
2. **Create your settings file.** In that folder, copy `.env.example` to `.env` and adjust it. The defaults suit
   most setups.
   ```bash
   cp .env.example .env
   ```
3. **Add the stack.** In **Docker → Compose → Add New Stack**, point the stack at that folder (its
   `docker-compose.yml`), then press **Compose Up**. From a terminal in the folder, this does the same:
   ```bash
   docker compose up -d --build
   ```
4. **Open the app.** Go to `http://tower:8080`, or `http://<server-ip>:8080`.
5. **Set your password.** On the first run you're asked for a one-time **setup code**. Find it in the container
   log (Docker tab → tower-tracker icon → **Logs**, or `docker logs tower-tracker`). Then choose a password of 12+
   characters. To skip this step, set `APP_PASSWORD` in `.env` instead.

**Where the data lives.** `DATA_PATH` (default `/mnt/cache/appdata/tower-tracker`) holds the database
(`tower.db`), the attachments, and `backups/`.

Use the **pool path** (`/mnt/cache/…`) rather than `/mnt/user/…` unless the appdata share has **Exclusive access:
Yes**. SQLite shouldn't go through Unraid's user-share (FUSE) layer.

To check this setting:
1. Go to **Shares → appdata**. The share needs **Primary storage** set to your pool and **Secondary storage: None**.
2. Enable it under **Settings → Global Share Settings → Permit exclusive shares**.
3. Make sure no stray `appdata` folder exists on an array disk.

**Updating.** Pull the new code, then rebuild. The database upgrades itself on start.

```bash
cd /mnt/user/appdata/tower-tracker-src && git pull && docker compose up -d --build
```

## Configuration (`.env`)

Docker Compose reads `.env` from the folder with `docker-compose.yml`. After changing it, apply the change with:

```bash
docker compose up -d
```

Data is untouched by this.

| Variable | Default | |
|---|---|---|
| `PORT` | `8080` | The port to open the app on. It's used both on Unraid and inside the container, so one setting changes both. |
| `DATA_PATH` | `/mnt/cache/appdata/tower-tracker` | Host folder for the database, attachments and backups. |
| `TZ` | `America/Chicago` | All dates, times, due badges, calendar days and schedules use this zone. |
| `APP_PASSWORD` | — | Optional. When set, this is the password, and it can't be changed in the app. Single-quote it if it contains `$`. |
| `MAX_UPLOAD_MB` | `25` | Largest attachment. |
| `PUID` / `PGID` | `99` / `100` | Owner of the files in `DATA_PATH` (Unraid's nobody:users). |
| `TRUST_PROXY` | — | Only when a reverse proxy sits in front: the proxy's LAN IP. Never `true`. |

Advanced settings the app understands (add them under `environment:` in `docker-compose.yml` if needed):

| Variable | Default | |
|---|---|---|
| `MAX_IMPORT_MB` | `2048` | Largest backup you can restore. |
| `APP_PASSWORD_FILE` | — | Read the password from a file instead of `APP_PASSWORD`. |
| `UMASK` | `0002` | Permissions for new files. |
| `COOKIE_SECURE` | `auto` | `auto` sets the Secure flag on HTTPS requests. |
| `SESSION_DAYS` | `90` | How long "Remember this device" lasts (it slides with use). |
| `LOG_LEVEL` | `info` | |

**Forgot the password?** Set `APP_PASSWORD` in `.env`, then run `docker compose up -d`. This sets the new password and
signs out every device. You can remove the variable afterwards, and the password stays.

## Reaching it from your phone (Tailscale)

### Option A: Tailscale straight to the server (simplest)

Use this if Tailscale runs on Unraid itself, or the NPM VM acts as a **subnet router** for your LAN.

- On the phone, open `http://tower:8080` (with MagicDNS) or `http://<tailscale-or-lan-ip>:8080`.
- Plain HTTP over Tailscale is fine: the tunnel is already encrypted, and everything in the app works.
- Leave `TRUST_PROXY` unset.

### Option B: an HTTPS name through Nginx Proxy Manager

Because ports 80/443 are forwarded to NPM, a proxy host is reachable from the internet by anyone who knows or guesses
its name. So do all of this:

1. **Add a proxy host.** Forward `http` to `<unraid-ip>` on the app's `PORT`, and turn on **Websockets Support**
   (harmless).
2. **Restrict it with an Access List.** Under **Access Lists → Add**, allow only your LAN (e.g. `192.168.1.0/24`) and
   Tailscale (`100.64.0.0/10`), and deny all. Select that list on the proxy host. Without it, the app's own password
   is the only protection.
3. **Raise the upload limit.** On the proxy host's **Advanced** tab, add
   `client_max_body_size 2048m;` (or at least `MAX_UPLOAD_MB`). Otherwise uploads and restores over about 1 MB fail.
4. **Trust the proxy.** Set `TRUST_PROXY=<NPM VM's LAN IP>` in `.env`, then run `docker compose up -d`. The login
   rate limit then sees real client addresses, and cookies get the Secure flag over HTTPS.

**Optional: HTTPS without NPM.** `tailscale serve` (or Unraid 7's per-container Tailscale) gives the app a
`https://<name>.<tailnet>.ts.net` address that only your tailnet can reach.

### Home Screen app

On the iPhone, open the app in Safari, tap Share, then **Add to Home Screen**. It opens full-screen. The Home Screen
app keeps its own login, so sign in once there (tick **Remember this device**).

## Backup & restore

- **Full backup by copying files.** With the container **stopped**, copying `DATA_PATH` (e.g. Unraid's **Appdata
  Backup** plugin, which stops containers by default) is a complete backup: database, attachments and snapshots.
  Restore by copying it back.
- **Nightly snapshots.** The app saves a consistent copy of the database to `/data/backups/tower-YYYY-MM-DD.db` every
  day and keeps the last 7. So even a copy taken while the container is running contains a good database. To use
  one, stop the container, copy the snapshot over `tower.db` (and delete `tower.db-wal` / `tower.db-shm` if
  present), then start the container.
- **Export.** Go to **Menu → Backup & restore**.
  - **Download ZIP**: everything, including attachment files.
  - **Download JSON**: data only.
  - Your password isn't included.
- **Restore.** On the same page, choose a `.zip` or `.json` export.
  1. The backup is checked, and you get a preview: card count, history, attachments, and a time-zone warning if it
     came from a different `TZ`.
  2. You type `RESTORE` to confirm.
  3. Everything is replaced. The previous database (and attachments) is kept as `/data/backups/pre-restore-…`, and
     the last 5 are kept.
  4. You stay signed in.

  Backups from older versions upgrade automatically; backups from a newer version are refused.
- **Moving to a new server.** Export a ZIP, start a fresh container there, set its password, then restore the ZIP.

## Card import (AI → cards)

**Menu → Import cards → Copy AI prompt.**
1. Give the prompt to an AI, then describe the problem.
2. Paste its answer back.
3. Preview, then Import.

The format accepts priorities like `P1` or `high`, labels by name, due dates with an optional time, checklists and
backdated work-log notes. Full format: [docs/CARD-IMPORT.md](docs/CARD-IMPORT.md).

## Keyboard shortcuts (desktop)

| Key | |
|---|---|
| `n` | New card in Triage |
| `/` | Search |
| `Esc` | Close the top menu, dialog or card |
| `Space`, then the arrow keys, then `Space` | Move a focused card with the keyboard |
| `Ctrl/⌘ + Enter` | Save the description or work-log note being edited |

## Troubleshooting

- **"Setup code" not accepted.** A new code is printed every time the container starts. Use the newest one in the log.
- **Login rate limit.** 5 wrong passwords lock that address out for 15 minutes. Restarting the container clears it.
- **Port changes don't take effect.** Change `PORT` in `.env` (not the numbers in `docker-compose.yml`), then run
  `docker compose up -d`.
- **Permission errors on `/data`.** Check that `PUID`/`PGID` match the owner you expect. The container fixes ownership
  of files inside `DATA_PATH` on start.
- **Logged out unexpectedly while testing two copies on one machine.** Cookies are per host, not per port, so two
  Tower Tracker instances on `localhost:8080` and `localhost:8090` sign each other out. Use different host names.

---

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

Try the container on a desktop. Data goes to a named volume instead of the Unraid path:

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
```

Layout:
- `shared/`: API types and validation shared by both sides.
- `server/`: Fastify and SQLite (`services/` holds all the logic, `test/` the tests).
- `web/`: React and Vite.
- `docker/entrypoint.sh`: handles PUID/PGID.

# Install and configure

This walks through running Belltower on Unraid with the Docker Compose Manager plugin. Any machine with Docker
Compose works the same way; only the paths change.

Nothing gets built on the server. Tower pulls a ready-made public image from GitHub
(`ghcr.io/bernie-sandler/belltower`), so there's no registry login.

Prefer Unraid's own **Add Container** form over Compose? Copy [unraid/belltower.xml](../unraid/belltower.xml)
to `/boot/config/plugins/dockerMan/templates-user/my-belltower.xml` on the flash drive, then pick
**belltower** from the Template list on **Docker → Add Container**. Every setting below has a field there
(the advanced ones appear under **Show more settings**), and Unraid passes its own time zone in as `TZ`.

## 1. Get the stack files onto the server

Clone the repository somewhere **outside** the folder that will hold your data. Only `docker-compose.yml` and your
`.env` are actually used from it.

```bash
git clone https://github.com/bernie-sandler/Belltower.git /mnt/user/appdata/belltower-src
```

## 2. Create your settings file

```bash
cd /mnt/user/appdata/belltower-src
cp .env.example .env
```

The defaults suit most setups. The [settings table](#settings-env) below explains each one.

## 3. Start it

In **Docker → Compose → Add New Stack**, point the stack at that folder, then press **Compose Up**. From a terminal
in the folder, this does the same thing:

```bash
docker compose up -d
```

## 4. Create your account

Open `http://tower:8080` (or `http://<server-ip>:8080`). On the very first run it asks for a one-time **setup code**,
which is printed in the container log: in the Docker tab, click the belltower icon and choose **Logs**, or run
`docker logs belltower`. Then choose a username (`admin` unless you change it) and a password of at least 12
characters. This is the **owner** account: an admin that can't be demoted or deactivated, so there's always a way in.
You can add other people later, as admins or members.

If you'd rather skip that step, set `APP_PASSWORD` in `.env` before starting: the owner account is then `admin` with
that password.

That's it. Next steps you might want:
- [reach it from your phone](REMOTE-ACCESS.md);
- check that [backups](BACKUP.md) are covered;
- turn on [notifications](NOTIFICATIONS.md) (Discord, ntfy, Gotify or a webhook) or the [submit page](SUBMIT-PAGE.md).

## Where your data lives

Everything lives in the folder set by `DATA_PATH` (default `/mnt/cache/appdata/belltower`):

- the database, `tower.db`;
- your attachments;
- `backups/`, with nightly snapshots and the copies made before upgrades.

**Use the pool path** (`/mnt/cache/…`) rather than `/mnt/user/…`, unless the appdata share has **Exclusive access:
Yes**. SQLite doesn't get along with Unraid's user-share (FUSE) layer, and the pool path skips it.

To turn on exclusive access instead:
1. In **Shares → appdata**, set **Primary storage** to your pool and **Secondary storage** to **None**.
2. Enable **Settings → Global Share Settings → Permit exclusive shares**.
3. Make sure there's no stray `appdata` folder on an array disk.

## Settings (`.env`)

Docker Compose reads `.env` from the folder with `docker-compose.yml`. After changing it, run `docker compose up -d`.
That recreates the container and leaves your data alone.

| Setting | Default | What it does |
|---|---|---|
| `TT_VERSION` | `latest` | Which image to run: `latest` (stable releases) or an exact version like `1.2.3`. |
| `PORT` | `8080` | The port the app is reached on. One setting covers both Unraid and the container. |
| `DATA_PATH` | `/mnt/cache/appdata/belltower` | The host folder for the database, attachments and backups. |
| `TZ` | `America/Chicago` | Your time zone. Every date, due badge, calendar day and schedule uses it. |
| `APP_PASSWORD` | (empty) | Optional. When set, this *is* the owner account's password, and it can't be changed in the app. Other people's passwords aren't affected. Wrap it in single quotes if it contains a `$`. |
| `MAX_UPLOAD_MB` | `25` | The largest attachment you can upload. |
| `PUID` / `PGID` | `99` / `100` | Who owns the files in `DATA_PATH` (Unraid's nobody:users). |
| `TRUST_PROXY` | (empty) | Only when a reverse proxy sits in front: that proxy's LAN IP. Never `true`. See [remote access](REMOTE-ACCESS.md). |
| `ANTHROPIC_API_KEY` | (empty) | Optional. Turns on [Claude drafting](AI-DRAFTING.md). |

A few more the app understands, for the rare case you need them. Add them under `environment:` in
`docker-compose.yml`:

| Setting | Default | What it does |
|---|---|---|
| `MAX_IMPORT_MB` | `2048` | The largest backup you can restore. |
| `APP_PASSWORD_FILE` | (empty) | Read the owner's password from a file instead. |
| `ANTHROPIC_API_KEY_FILE` | (empty) | Read the API key from a file instead. |
| `ANTHROPIC_MODEL` | `claude-opus-5-5` | The Claude model (Settings can override it). |
| `SESSION_DAYS` | `90` | How long "Remember this device" lasts. It renews as you use the app. |
| `COOKIE_SECURE` | `auto` | `auto` marks cookies Secure on HTTPS requests. |
| `UMASK` | `0002` | Permissions for new files. |
| `LOG_LEVEL` | `info` | How chatty the log is. |

## Forgot the password?

Set `APP_PASSWORD` in `.env` and run `docker compose up -d`. That sets the owner account's password, makes sure the
owner is an active admin again, and signs the owner out on every device (nobody else). Sign in with the owner's
username (`admin` on installs from before 1.5, which also accept the old name `tower-tracker`) or leave the username
empty. You can remove the line afterwards; the password stays.

Someone else forgot theirs? An admin sets a new password for them; that signs them out everywhere.

## Troubleshooting

**The setup code isn't accepted.** A new code is printed every time the container starts, so use the newest one in
the log.

**"Too many attempts".** Five wrong passwords lock that address out for 15 minutes. Restarting the container clears
it.

**Changing the port doesn't work.** Change `PORT` in `.env` (not the numbers in `docker-compose.yml`), then run
`docker compose up -d`.

**Permission errors on `/data`.** Check that `PUID`/`PGID` match the owner you expect. The container fixes the
ownership of files inside `DATA_PATH` when it starts.

**It won't start after an update.** Look at the log first: if a database upgrade couldn't save its safety copy (a
full disk, usually), it stops without changing anything and tells you why. [Upgrading](UPGRADING.md#if-something-goes-wrong)
covers rolling back.

**Signed out unexpectedly while testing two copies on one machine.** Browsers keep cookies per host name, not per
port, so two instances on `localhost:8080` and `localhost:8090` sign each other out. Give them different names.

**Another device can't reach it.** See [Automation → If a tool can't reach it](AUTOMATION.md#if-a-tool-cant-reach-it);
the same checks apply to a phone or laptop.

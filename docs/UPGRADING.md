# Upgrading

## Updating to a new version

From the folder with `docker-compose.yml`:

```bash
docker compose pull && docker compose up -d
```

On Unraid's Compose page, **Update Stack** does the same.

When a new version needs a newer database layout, the app upgrades the database on its first start. It's careful
about it:

1. First it saves a copy of the database as it was, in `backups/pre-migrate-v<old>-to-v<new>-<time>.db`. The last
   five copies are kept.
2. If that copy can't be written (a full disk, say), it **doesn't upgrade at all**. It stops and says why in the
   log, and your data stays exactly as it was.
3. Then it upgrades, checks the database, and carries on as normal.

You'll see lines like these in the log:

```
Saved a copy of the database before upgrading it: /data/backups/pre-migrate-v5-to-v6-….db
Applied database migration(s): 6
```

## Picking a version

`TT_VERSION` in `.env` decides what `docker compose pull` fetches:

| Value | You get |
|---|---|
| `latest` | The newest stable release. The right choice from 1.0 on. |
| `1` or `1.0` | The newest release within 1.x or 1.0.x. |
| `1.0.0` | Exactly that version, until you change it. |
| `rc` | The newest release candidate. It only moves when there's a new one, so it can fall behind `latest`. |
| `beta` | The newest beta (0.8–0.10). Not updated after 1.0. |

## Moving from a beta to 1.0

If you've been on `beta` or `rc`, your data comes along untouched. Every database and backup from 0.5 onwards is checked
against 1.0 before release, both upgraded in place and restored from an export.

1. Optional but nice: export a ZIP (**Menu → Backup & restore → Download ZIP**) and keep it somewhere off the
   server.
2. In `.env`, set `TT_VERSION=latest`.
3. Run `docker compose pull && docker compose up -d`.

Nothing in your `.env` needs to change beyond that.

**Coming from a 0.5–0.7 alpha that was built on the server?** Point the stack at the image the same way: take the
current `docker-compose.yml` and `.env.example` from the repository, carry over your values (`PORT`, `DATA_PATH`,
`TZ`, `APP_PASSWORD`, …), set `TT_VERSION`, and run `docker compose up -d`. Keep `DATA_PATH` the same and
everything is still there.

## Coming from Tower Tracker

Tower Tracker became Belltower in 1.2. Your data doesn't change, but the Docker container and stack have a new name,
so this one update takes a few extra steps.

1. Stop the old stack **before** you fetch the new files: press **Compose Down** on Unraid's Compose page, or run
   `docker compose down` in the stack folder. Don't add `-v`. If you've already fetched them, run
   `docker compose -p tower-tracker down --remove-orphans` instead. Otherwise the old container keeps the port and
   the new one can't start.
2. Fetch the new files with `git pull`.
3. Check that `.env` still has `DATA_PATH` pointing at your existing folder, for example
   `DATA_PATH=/mnt/cache/appdata/tower-tracker`. There's no need to rename the folder. New installs default to
   `/mnt/cache/appdata/belltower`, so without this line the app starts empty and asks you to set a password. If that
   happens, nothing is lost: add the line and run `docker compose up -d` again.
4. Run `docker compose pull && docker compose up -d`.
5. On your phone, remove the old Home Screen icon and add it again. The phone keeps the name and icon from when you
   first added it.

On a desktop with `docker-compose.local.yml`, the steps are the same and the app keeps using its existing volume.

A few things keep the old name on purpose, because changing them would break what you already have:

| Name | Why it stays |
|---|---|
| `tower.db` and `backups/tower-<date>.db` | They're your database files. |
| `TT_VERSION` in `.env` | Your `.env` already uses it. |
| API tokens starting `tt_` | Uptime Kuma and your scripts keep working with the tokens they have. |
| `"format": "tower-tracker-backup"` inside backups | Every backup, old and new, restores the same way. |
| The image `ghcr.io/bernie-sandler/tower-tracker` | It follows the GitHub repository's name, which hasn't changed. |

## What 1.0 promises

From 1.0 on, the version numbers mean something:

- **Your data always moves forward.** Any 1.x reads every database and backup made by an earlier version, including
  the 0.x betas. Database changes only ever add things.
- **Backups stay readable.** A backup from any 1.x restores into any later 1.x. (It won't restore into an *older*
  version; that one doesn't know the newer layout.)
- **The automation API is stable.** [`/api/v1`](API-V1.md) won't change in a way that breaks your scripts or
  monitors within 1.x.
- **Breaking changes wait for 2.0**, and they'll be spelled out in the [changelog](../CHANGELOG.md).

## If something goes wrong

**It won't start.** Read the log (`docker logs belltower`). The common causes are a full disk (the safety copy
couldn't be written, so nothing changed) and permissions on `DATA_PATH`.

**You want to go back to the previous version.** A newer database can't be opened by an older app, so roll back
together with the safety copy:

1. Stop the container: `docker compose down`.
2. In `DATA_PATH`, move `tower.db` aside (and delete `tower.db-wal` / `tower.db-shm` if they're there).
3. Copy the newest `backups/pre-migrate-…db` to `tower.db`.
4. Set `TT_VERSION` back to the version you came from and run `docker compose up -d`.

Anything you changed after the upgrade is lost this way. Export a backup first if that matters, then open an issue so
it can be fixed.

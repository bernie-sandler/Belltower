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
| `1` or `1.2` | The newest release within 1.x or 1.2.x. |
| `1.2.3` | Exactly that version, until you change it. |
| `rc` | The newest release candidate. It only moves when there's a new one, so it can fall behind `latest`. |

Images are at `ghcr.io/bernie-sandler/belltower` and go back to 1.2.1. The image is public, so pulling it doesn't need
a `docker login`.

## What 1.0 promises

From 1.0 on, the version numbers mean something:

- **Your data always moves forward.** Any 1.x reads every database and backup made by an earlier version. Database
  changes only ever add things.
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
4. Set `TT_VERSION` back to the version you came from and run `docker compose up -d`. Images go back to 1.2.1, so to
   return to anything older you'd have to build it yourself from its commit in the git history.

For example, 1.3 upgrades the database to layout 7 (for read-only API tokens), so a 1.2 image refuses to start on it
until you put the `pre-migrate-v6-to-v7-…db` copy back.

Anything you changed after the upgrade is lost this way. Export a backup first if that matters, then open an issue so
it can be fixed.

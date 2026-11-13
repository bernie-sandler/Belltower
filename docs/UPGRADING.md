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

## Upgrading to 1.5 (people)

1.5 turns the single password into accounts. Nothing needs doing, and nobody is signed out:

- Your password becomes the **owner** account, username `admin`. Sign in with `admin` (or leave the username empty).
  Password managers that saved the old login under `tower-tracker` keep working: that name still means the owner.
- Signed-in devices stay signed in, and every existing API token keeps working; both now belong to the owner.
- `APP_PASSWORD`, if you use it, now manages the owner's password only. "Set `APP_PASSWORD` and restart" still gets you
  back in.
- History from before 1.5 doesn't say who did what; everything from now on does.
- The team features (assignees, Mine and Unassigned, watching, @mentions, the bell and names in the history) stay
  hidden until an admin turns on **Settings → General → Teams**, so a solo install looks as it did. New tickets from
  the submit page still ring the bell for admins while Teams is off. See [USING.md](USING.md#teams).
- Coming from 1.5.0-rc.1 with more than one active person, Teams starts on, so a team keeps its features. That's
  decided once, the first time 1.5.0 starts; after that only an admin changes it (restoring an older backup keeps the
  setting you have).

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
until you put the `pre-migrate-v6-to-v7-…db` copy back. Likewise 1.5 upgrades to layout 11 (people, request type labels and
tag-restricted accounts), and going back to 1.4 means putting the `pre-migrate-v8-to-v11-…db` copy back (from a
1.5.0 release candidate it's named after the layout you came from, such as `pre-migrate-v9-to-v11-…db`).

Anything you changed after the upgrade is lost this way. Export a backup first if that matters, then open an issue so
it can be fixed. Rolling back from 1.5 also loses the accounts created since the upgrade (and who did what), and 1.4
signs in with the password you had before upgrading, since that's what the copy holds.

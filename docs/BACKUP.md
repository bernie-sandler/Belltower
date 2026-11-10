# Backups

Your tracker holds history you can't recreate, so it's worth a minute to know how it's protected. There are three
layers, and you get the first two for free.

## 1. Nightly snapshots (automatic)

Every day the app saves a consistent copy of the database to `backups/tower-YYYY-MM-DD.db` inside `DATA_PATH`, and
keeps the last 7. Before any database upgrade it also saves `backups/pre-migrate-…db` (the last 5 are kept).

Because the snapshots are always consistent, even a copy of `DATA_PATH` taken while the container is running
contains a good database.

**Using a snapshot:**
1. Stop the container.
2. Copy the snapshot over `tower.db`, and delete `tower.db-wal` and `tower.db-shm` if they're there.
3. Start the container.

Snapshots don't include attachments, and they live on the same disk as everything else, so they're no protection
against losing that disk. That's what the next two are for.

## 2. Copying the folder

With the container **stopped**, a copy of `DATA_PATH` is a complete backup: database, attachments and snapshots.
Unraid's **Appdata Backup** plugin does exactly this (it stops containers by default). To restore, copy the folder
back.

## 3. Export and restore (from the app)

**Menu → Backup & restore** (admins only):

- **Download ZIP** is everything, attachments included.
- **Download JSON** is the data without attachment files. It's smaller, and handy for scripts.

Passwords and signed-in devices are never part of an export. Everything else is, including people's names and
emails, API token hashes,
your notification addresses and tokens (Discord, ntfy, Gotify, webhook) and the submit page's link, so keep exports
somewhere private. (The format is
documented in [BACKUP-FORMAT.md](BACKUP-FORMAT.md).)

**Restoring** works on the same page. Choose a `.zip` or `.json` export, then:

1. The file is checked, and you see what's in it: how many cards, how much history, how many attachments. If it
   came from a server with a different time zone, you get a warning.
2. Type `RESTORE` to confirm.
3. Everything on the board is replaced. Your previous database and attachments are kept in
   `backups/pre-restore-…` (the last 5), so a restore is never a one-way door.
4. You stay signed in. Everyone on this server keeps their own password, role and devices: people are matched to the
   backup's by username, and anyone the backup doesn't have is kept. People only in the backup come back without a
   password until an admin gives them one.

Exports from any older version restore fine; they're upgraded on the way in. An export from a *newer* version is
refused, so update the app first.

## Moving to a new server

1. On the old server, **Download ZIP**.
2. On the new one, [install](INSTALL.md) Belltower and create the owner account (use the same username as before, so
   the backup's history and API tokens line up with you).
3. **Restore** the ZIP.

That carries over everything except passwords and signed-in devices. Other people come back without a password; give
each a new one.

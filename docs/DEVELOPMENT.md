# Development

How the code is laid out, how to run and test it, and the few rules that keep 1.x upgrades safe. The design notes
are in [DESIGN.md](DESIGN.md) and the web UI's API in [API.md](API.md).

## Layout

- `shared/`: API types and zod validation, used by both sides (`@tt/shared`).
- `server/`: Fastify and SQLite. `src/services/` holds the logic, `src/db/` the schema and migrations, `test/` the
  tests.
- `web/`: React and Vite.
- `e2e/`: Playwright tests that drive a real build in Chrome.
- `docker/entrypoint.sh`: sets up PUID/PGID before starting the app.

## Running it

You need Node 24.

```bash
npm install
npm run dev:server
```

In a second terminal, start the UI with hot reload (it proxies `/api` to the server):

```bash
npm run dev:web
```

In development the server keeps its data in `server/data/`; set `DATA_DIR` to use another folder.

To try the real container on a desktop (data goes into a named volume instead of an Unraid path):

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml -f docker-compose.local.yml up -d --build
```

## Checks

```bash
npm run typecheck        # everything
npm test                 # server and web unit tests
npm run build            # production bundles, plus a check that nothing loads from a CDN
npm run e2e              # end-to-end tests in your installed Chrome, desktop and iPhone sizes (build first)
```

GitHub Actions runs all of these, plus a Docker build and health check, on every push and pull request.

### Performance

A board with 20 work cards and 2,000 tickets, in a folder of its own:

```bash
npm run seed:perf -w @tt/server -- /tmp/tt-perf
```

It prints how long the board and search take. Start a server on it with `DATA_DIR=/tmp/tt-perf` to try the UI.
Targets for 1.0: `/api/board` under 300 ms on Tower, and a board that scrolls and drags smoothly on an iPhone. For
reference, on a desktop the board query takes about 18 ms, and a capped Done column keeps the page small however
many cards are finished.

## Rules that protect your data

These are what make the [1.x promises](UPGRADING.md#what-10-promises) true.

**Migrations** (`server/src/db/schema.ts`):
- Never edit a migration that has shipped. Add a new one.
- Within 1.x, migrations only add: new tables, new columns with defaults, new indexes. No dropping or renaming.
- Startup saves a copy before migrating and refuses to migrate if it can't (`backupBeforeMigrate`).
- `server/test/upgrade.test.ts` builds a database at every older schema, upgrades it, and restores a backup from
  every older schema. Extend `oldDatabase()` and `asExportFrom()` when you add a migration.

**The activity log is append-only.** Database triggers enforce it; migrations drop and recreate them around each
step (see `migrate.ts`).

**Backups** ([BACKUP-FORMAT.md](BACKUP-FORMAT.md)): a new table must be added to `BACKUP_TABLES` in
`services/backup.ts` (unless it holds secrets or rebuildable data), and the format doc's schema history updated.

**The automation API** ([API-V1.md](API-V1.md)) is frozen for 1.x. `server/test/api-v1-contract.test.ts` pins it.
Only add optional fields; anything else needs `/api/v2/`.

**Names from before the rename.** The app was Tower Tracker until 1.2. These keep the old name on purpose, so don't
"finish" the rename without a plan for existing installs:

- `tower.db` and `tower-<date>.db`: the files on disk, which existing installs already have.
- `tt_` API tokens and `TT_VERSION`: held by other tools and in people's `.env` files.
- `tt_sid` and the `tt:` / `tt-` browser storage keys: changing them signs people out and resets per-device settings.
- The `tower-tracker-backup` format id: frozen, see [BACKUP-FORMAT.md](BACKUP-FORMAT.md).
- The CSRF header value: tabs still open on the previous bundle would get `403` on every change.
- The hidden `username` field on the password forms: it's the account name saved in password managers.
- The volume name in `docker-compose.local.yml`: it's where an existing desktop install keeps its data.
- The `@tt/*` workspace names: internal, and never seen by anyone running the app.
- The `tower-tracker` image on GHCR: it's the only place versions before 1.2.0 exist, and rollbacks rely on it, so
  don't delete it.

## Releasing

Releases are cut from `main` by pushing a tag. The release workflow runs the full CI, builds the image and publishes
it to `ghcr.io/bernie-sandler/belltower`, then creates a GitHub Release from the matching CHANGELOG section. The
image name comes from the repository name, so renaming the repository also means publishing under the new name and
then updating `docker-compose.yml`, the docs and `unraid/belltower.xml`.

| Tag | Image tags | GitHub Release |
|---|---|---|
| `v1.2.0` | `:1.2.0`, `:1.2`, `:1`, `:latest` | release |
| `v1.2.0-rc.1` | `:1.2.0-rc.1`, `:rc` | pre-release |
| `v0.10.0-beta` | `:0.10.0`, `:beta` | pre-release |

Before tagging:
1. Set the version (without any `-rc.N` suffix) in all four `package.json` files (root, `shared`, `server`, `web`)
   and run `npm install --package-lock-only`. The workflow refuses a tag that doesn't match.
2. Add a `## <version>: <title>` section to `CHANGELOG.md`. It becomes the release notes, and every RC of a version
   shares it.
3. Make sure CI is green on `main`.

The app shows its version in Settings, in the container log and in every backup.

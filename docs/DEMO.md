# The browser-only demo

**[bernie-sandler.github.io/Belltower](https://bernie-sandler.github.io/Belltower/)** is Belltower with no server: the
real web app, with the API answered inside the page and the data kept in the visitor's browser. Nothing to install,
nothing shared between visitors, and "Reset demo data" puts the sample board back.

It's built from the same `web/` code as the app, as a separate build (`npm run build:demo`). Nothing from the demo
goes into the app's own bundle, and the build checks that (see [Keeping it out of the app](#keeping-it-out-of-the-app)).

## Running it locally

```bash
npm install
npm run dev:demo
```

Then open <http://localhost:5174/Belltower/>. No server needed. To try the production build of the demo, the way
GitHub Pages serves it:

```bash
npm run build:demo
npm run preview:demo -w @tt/web
```

and open <http://localhost:4174/Belltower/>. The demo keeps its data per address, so localhost and the Pages site
each have their own board.

## How it works

`vite --mode demo` loads `web/.env.demo`, which sets `VITE_DEMO=true`. With that flag, `web/vite.config.ts`:

- builds with `web/src/demo/main.tsx` as the entry, which installs the demo and then starts the normal `src/main.tsx`;
- sets the base path to `/Belltower/` (the Pages workflow passes the path Pages reports instead);
- points the app's `react-router` imports at `src/demo/router.tsx`, where `BrowserRouter` is a `HashRouter`. Pages
  has no fallback to `index.html`, so routes live after the `#` (`/Belltower/#/cards/12`), and a deep link or a
  refresh never 404s;
- writes to `web/dist-demo/`, leaves out the web app manifest and has no `/api` proxy.

Everything else is in `web/src/demo/`:

| File | What it does |
|---|---|
| `transport.ts` | Wraps `fetch` and `XMLHttpRequest`: a same-origin request to `/api/…` goes to the demo's routes after a 100–300 ms delay (so loading states show), anything else goes to the network. The app's own `src/api/client.ts` runs unchanged on top, and so do the three calls that don't use it (the submit page's form, attachment uploads, backup restore). No service worker. |
| `downloads.ts` | Plain links to `/api/…` (the backup download buttons) are page loads, not requests, so a click listener answers them instead. |
| `server/routes.ts` | Every route in `server/src/http/routes`, typed with the response types from `@tt/shared`, plus the server's CSRF and sign-in checks. |
| `server/*.ts` | The services, named after their counterparts in `server/src/services` and following them closely, over plain arrays instead of SQLite. Bodies and queries are checked with the same zod schemas from `@tt/shared`, so bad input gets the same `400` and message as on a real install. Dates, time zones and recurring schedules use the server's own `server/src/lib` files. Search has no FTS5, so `search.ts` matches word prefixes itself and marks hits the way FTS5's snippets do. |
| `store.ts` | The data, in localStorage under `belltower-demo:v<N>`. Each request works on a copy and saves it only if it succeeds, like a transaction. |
| `seed.ts` | The sample board, built by replaying a few weeks of history through the services with the clock set back, so ticket numbers, ages, history and the calendar look real. |
| `DemoBanner.tsx`, `demo.css` | The banner: "everything is stored in your browser only", View as Owner or Submitter, Reset demo data, and a link to the install guide. |

### Owner and Submitter

Since 1.5 Belltower has accounts (admins and members), and people without one use the
[submit page](SUBMIT-PAGE.md), which needs no sign-in. The demo has no passwords: it's seeded with the owner (`admin`,
the visitor) and two more people, Alex (an admin) and Jordan (a member), so the directory and history have names in
them. The banner's switch is:

- **Owner**: signed in as `admin`, the whole app. The demo starts here.
- **Submitter**: signed out, on the public submit page. Going to the board from there shows the sign-in page, where
  any password (with any username, or none) signs you in as the owner again.

The demo always signs in the owner, so it never shows the app as a member sees it. Adding people and changing their
role or name works in the browser; a password given to someone new is checked and then forgotten.

**Teams** (Settings → General) is on in the demo, unlike a fresh install, so visitors see assignees, watching and the
bell; turning it off shows Belltower as a solo install sees it. Demo data saved before the setting existed reads as
on too, so it didn't need a new `DEMO_SCHEMA_VERSION`.

### What the demo can't do

These need the server. They answer `400` with the code `demo_unavailable`, so the app shows its usual error with a
message that starts "Not available in the demo":

- attachments (upload; there are none to view or delete), and screenshots on the submit page
- backup export and restore (there are no snapshots either)
- notifications: saving an address or token (Discord, ntfy, Gotify, webhook), sending a test or a summary. The
  alert levels, summary time and each channel's checkboxes can still be changed. Under Account → Notifications, a
  personal Discord user ID or ntfy topic and **Send me a test** need the server too; what goes where is saved. The
  bell, watching, @mentions and the sound work in the demo (it starts with two unread notifications from the other
  demo people, above the submit page's tickets, which are already read).
- Claude drafting (it shows as off, as on an install without `ANTHROPIC_API_KEY`)
- API tokens and the automation API (`/api/v1`)
- changing the password (there are none)
- single sign-on: its settings and linking an account (the login page never offers it)

Tag-restricted accounts: an admin can set **Restrict to tags** on a demo person, and it's saved, but the demo
doesn't filter anything by it: the demo always signs in as the owner, who can't be restricted, so there's nobody to
hide tickets from.

Card import (JSON) works, all in the browser. Recurring templates run when the board loads instead of on a timer.
The submit page has no rate limit.

## Rules

**Every new API endpoint needs a matching demo handler.** Add the route to `DemoApi` and `routes` in
`web/src/demo/server/routes.ts`, with the response type the server sends. If the server can't do it in a browser,
answer with `notInDemo('…')`. You'll be reminded:

- `web/src/demo/routes.test.ts` reads `server/src/http/routes/*.ts` and fails when a server route has no demo handler,
  or the demo answers a route the server doesn't have.
- `npm run typecheck` fails when a handler's result doesn't match its response type, so a change to a type in
  `@tt/shared` has to reach the demo too.

**When a service changes, change its demo twin.** The file with the same name in `web/src/demo/server/` should behave
the same way. The tests can't see behavior the types don't capture, so a quick click through the demo helps.

**When the demo's stored data changes shape, bump `DEMO_SCHEMA_VERSION`** in `web/src/demo/server/db.ts`. Visitors
with older data then get a fresh board instead of an error. (Version 3, for 1.5, already holds people, assignees,
watchers and notifications.)

**Admin-only routes are marked in the demo too.** A server route registered with the `ADMIN` option needs `admin(…)`
around its demo handler; `routes.test.ts` checks the two lists match.

**Request body schemas live in `@tt/shared`**, so the demo checks input with the same schema as the server. A route
that validates with a schema of its own (as `/api/import/cards` did with `CardImportBody`) should move it there.

## Keeping it out of the app

- Nothing outside `web/src/demo/` imports from it. Only the demo entry does, and only the demo build uses that entry.
- `scripts/check-dist.mjs`, which runs as part of `npm run build` (in CI and in the Docker build), fails if text that
  only exists in the demo shows up in `web/dist`.
- Tests and typecheck do cover `web/src/demo/`, so a change that breaks the demo fails CI.

## Deployment

`.github/workflows/demo.yml` builds the demo on every pull request, and on every push to `main` builds it and
publishes it to GitHub Pages with `actions/configure-pages`, `actions/upload-pages-artifact` and
`actions/deploy-pages`. It needs Pages turned on once: **Settings → Pages → Build and deployment → Source: GitHub
Actions**.

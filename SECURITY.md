# Security

Tower Tracker is a single-user app meant for a home network or a tailnet. This page says what it protects, what
it relies on you for, and how to report a problem.

## Reporting a problem

Open a private security advisory on GitHub (**Security → Report a vulnerability**) rather than a public issue.
Please include the version (Settings, or the container log) and steps to reproduce.

Fixes go into the newest 1.x release.

## What the app does

- **Password.**
  - One password, hashed with scrypt.
  - 5 wrong attempts lock that address out for 15 minutes, and logins are also paced globally.
  - Behind a reverse proxy, the real client address is only used when `TRUST_PROXY` names that proxy.
- **Sessions.**
  - An HTTP-only, SameSite=Lax cookie; only a SHA-256 hash of it is stored.
  - It gets the Secure flag over HTTPS.
  - Changing or resetting the password signs out every device.
- **Cross-site requests.** Every change needs the `X-Requested-With: tower-tracker` header, and the Origin must
  match the Host. A strict Content-Security-Policy allows only the app's own scripts, styles and images.
- **Your content.**
  - Markdown is rendered without raw HTML.
  - Attachments are served under a sandboxed policy where scripts can't run. Only files checked to be images or
    plain text display in the page; everything else downloads.
  - Uploads and restores have size limits; ZIP restores accept only the expected files.
- **History** can't be edited or deleted, not even through the database file: triggers block it.
- **Outbound connections.** None unless you turn something on:
  - With `ANTHROPIC_API_KEY`, only the text you type or paste into Add ticket, your label names, today's date and
    the ticket numbers and titles of your open cards are sent to Anthropic's API, from the server.
  - With a Discord webhook, card titles, ticket numbers and priorities go to that Discord channel. Only Discord
    webhook addresses are accepted, so the server can't be pointed elsewhere.
- **Submit page** (off by default).
  - It's reachable without the password by anyone who has its long random link.
  - It can only file tickets, and shows nothing from the board except your request types and the tags you chose.
  - It's rate limited, rejects non-image screenshots, and has a hidden field that catches simple bots.
  - **New link** cuts off the old address.
- **API tokens** can only open and update tickets through `/api/v1`. Only a hash of each is stored. Revoke them in
  Settings.
- **Upgrades.**
  - The database is copied before every schema upgrade.
  - A nightly snapshot keeps the last 7 days.
  - Dependencies are checked with `npm audit` and updated through Dependabot.

## What you need to do

- **Don't put it straight on the internet.** Reach it over your LAN or Tailscale. If you publish it through a
  reverse proxy (for example Nginx Proxy Manager), add an access list for your LAN and Tailscale ranges. The
  app's password should not be the only thing in the way.
- **Use HTTPS** when it's reached through a proxy with a public name, so cookies get the Secure flag.
- **Sharing the submit page publicly.** Let only `/submit/`, `/api/public/` and `/assets/` past your access
  list. Treat the link like a guest key, and replace it if it ends up somewhere you don't want.
- **Set `TRUST_PROXY`** only to your proxy's own address, and never to `true`.
- **Keep secrets in `.env`**, which isn't in git: `APP_PASSWORD` and `ANTHROPIC_API_KEY`. A GitHub token used to
  pull images should only have the `read:packages` scope.
- **Back up `/data`** (or use the export). The pre-upgrade copies and nightly snapshots live in the same folder,
  so they don't protect against losing the disk.
- **Keep exports private.** They don't contain your password, but they do contain the submit page's link, the
  Discord webhook address and API token hashes. See [docs/BACKUP-FORMAT.md](docs/BACKUP-FORMAT.md).

# Security

Belltower is a self-hosted app for a household or a small team, meant for a home network or a tailnet. This page says what it protects, what
it relies on you for, and how to report a problem.

## Reporting a problem

Open a private security advisory on GitHub (**Security → Report a vulnerability**) rather than a public issue.
Please include the version (Settings, or the container log) and steps to reproduce.

Fixes go into the newest 1.x release.

## What the app does

- **Accounts and passwords.**
  - Each person has a username and a password, hashed with scrypt. Accounts are deactivated, never deleted.
  - A wrong password, an unknown username and a deactivated account fail the same way and take the same time, so
    login doesn't reveal which usernames exist.
  - 5 wrong attempts lock that address out for 15 minutes, and logins are also paced globally.
  - Behind a reverse proxy, the real client address is only used when `TRUST_PROXY` names that proxy.
  - The owner account can't be demoted or deactivated, and `APP_PASSWORD` resets it, so the install can't lock
    itself out.
- **Single sign-on** ([OIDC](docs/SSO.md), off by default).
  - Authorization code flow with PKCE (S256), `state` and `nonce`. A short-lived HTTP-only, SameSite=Lax cookie ties
    the provider's answer to the browser that started the sign-in, and each sign-in works once.
  - The ID token's signature, issuer, audience, nonce and times are checked (30 seconds of clock tolerance).
  - Nobody gets an account just by signing in: new accounts are only made when an admin turns that on, and then as
    members. Linking by email is off by default, needs an email the provider marks verified, never picks an admin, and
    does nothing when several accounts share the email. The required group is checked at every sign-in.
  - Deactivated people are refused. Password login always stays available, so a broken provider can't lock you out.
  - The client secret is never shown again once saved, is never in a backup, and can come from `OIDC_CLIENT_SECRET`
    instead. Pointing the issuer at another host forgets a saved secret. A plain-HTTP issuer needs an explicit switch.
- **Roles.** Admins manage people, the install's settings (submit page, notification channels), backups and
  restores; members do the board work and manage their own profile, password and API tokens. The server enforces
  this on every request, and each change is recorded with who made it.
- **Sessions.**
  - An HTTP-only, SameSite=Lax cookie; only a SHA-256 hash of it is stored.
  - It gets the Secure flag over HTTPS.
  - Changing your password signs you out on your other devices; an admin resetting someone's password or
    deactivating them signs that person out everywhere.
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
  - With [notifications](docs/NOTIFICATIONS.md) set up, card titles, ticket numbers, columns and priorities go to
    the channels you chose: Discord, ntfy, Gotify or a webhook. Descriptions and work logs never do.
    - The Discord channel only accepts Discord webhook addresses.
    - ntfy, Gotify and webhooks accept any `http(s)` address, including ones on your network. Only an admin, signed
      in, can set them.
    - Saved tokens and secrets are never shown again. Pointing a channel at another server, port or scheme (`https`
      to `http` included) forgets its saved token.
    - Redirects aren't followed, so a token can't be passed on to another host.
    - Errors show only the status code, so **Send test** can't be used to read other pages on your network.
    - Text from other people is Markdown-escaped in ntfy and Gotify, so it can't load images or hide links.
  - With single sign-on on, the server talks to your identity provider (its discovery document, keys, token and
    userinfo endpoints) to sign people in.
- **Submit page** (off by default).
  - It's reachable without the password by anyone who has its long random link.
  - It can only file tickets, and shows nothing from the board except your request types and the tags you chose.
  - After sending, people get a **status link** for their own ticket. It shows the title, number, dates, a simple
    state and the resolution reason, and nothing else. Links are signed per ticket, only work while the page is on,
    and **Reset status links** cuts them all off.
  - It's rate limited, rejects non-image screenshots, and has a hidden field that catches simple bots.
  - **New link** cuts off the old address.
- **API tokens** can only open and update tickets through `/api/v1` and read its ticket counts. Read-only tokens
  (for dashboards) can only read the counts, never ticket details. Only a hash of each is stored. Each belongs to the
  person who made it and stops working while they're deactivated. Revoke them in Settings.
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
- **Keep secrets in `.env`**, which isn't in git: `APP_PASSWORD`, `ANTHROPIC_API_KEY` and `OIDC_CLIENT_SECRET`.
- **Use an HTTPS issuer** for single sign-on, and keep the clocks right (NTP) on the server and the provider.
- **Back up `/data`** (or use the export). The pre-upgrade copies and nightly snapshots live in the same folder,
  so they don't protect against losing the disk.
- **Keep exports private.** They don't contain passwords, but they do contain people's names and emails, the submit page's link,
  notification addresses and tokens (Discord, ntfy, Gotify, webhook) and API token hashes. See [docs/BACKUP-FORMAT.md](docs/BACKUP-FORMAT.md).

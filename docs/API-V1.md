# Automation API, version 1

This is the stable contract for tools and scripts that open tickets (Uptime Kuma, Unraid, Home Assistant, your own
scripts) and for dashboards that show ticket counts (Homepage, Home Assistant). For recipes and a gentler introduction, see [AUTOMATION.md](AUTOMATION.md).

Everything under `/api/v1/` follows the rules on this page for the whole of Belltower 1.x. (The app's other
routes, documented in [API.md](API.md), are internal to the web UI and may change between versions.)

## Stability promise

Within v1:

- **Requests that work keep working.** Fields, accepted values and status codes documented here won't be removed or
  change meaning.
- **New things are optional.** New request fields will always be optional, and responses may gain new fields. Your
  client should ignore response fields it doesn't recognize.
- **The `status` values below are the complete set.** No new ones will appear in v1.
- Anything incompatible would go into a new `/api/v2/`, with `/api/v1/` kept working alongside it for at least one
  major release.

## Authentication

Create a token under **Settings → Automation**. Tokens start with `tt_` and are shown only once. Send one on every
request:

```
Authorization: Bearer tt_…
```

`/api/v1/` accepts tokens only. Session cookies and the web UI's CSRF header aren't used or needed. A missing,
mistyped or revoked token gets `401`.

Each token is one of two kinds:

- **Full** tokens can use everything below. Their one switch, **may complete tickets** (`canComplete`), decides what a
  recovery does (see `event` below). Every token created before 1.3 is a full token.
- **Read-only** tokens (since 1.3) can only make `GET` requests: today that's [`GET /api/v1/summary`](#get-apiv1summary).
  Anything else gets `403 forbidden`. They never complete tickets. Use them for dashboards, so a token that sits in a
  dashboard's config file can't open or close tickets.

## Limits

- 120 requests per minute per token. Beyond that you get `429` with a `Retry-After` header (in seconds).
- Request bodies up to 2 MB.

## Errors

Errors are JSON with a stable machine-readable `error` code and a human-readable `message`:

```json
{ "error": "validation", "message": "Missing \"title\"", "errors": ["Missing \"title\""] }
```

| HTTP | `error` | When |
|---|---|---|
| 400 | `validation` | The card doesn't validate. `errors` lists every problem. |
| 401 | `unauthenticated` | No valid token. |
| 403 | `forbidden` | A read-only token tried something other than `GET`. |
| 413 | `too_large` | The body is over 2 MB. |
| 429 | `rate_limited` | Over 120 requests a minute. `retryAfterSec` and the `Retry-After` header say when to retry. |
| 500 | `internal` | A bug. Retrying later is reasonable. |

## `GET /api/v1/summary`

Ticket counts for a dashboard. Any token works, read-only included. Added in 1.3.

```json
{
  "open": 12,
  "received": 3,
  "inProgress": 6,
  "waiting": 3,
  "urgent": 1,
  "overdue": 2,
  "dueToday": 1,
  "completedToday": 4,
  "completed7d": 19,
  "oldestOpenDays": 41,
  "byPriority": { "P0": 0, "P1": 1, "P2": 5, "P3": 2, "none": 4 },
  "bySeverity": { "S1": 0, "S2": 1, "S3": 0, "S4": 0, "none": 11 },
  "generatedAt": "2026-10-28T19:04:05.123Z"
}
```

Tickets are counted, not work cards, except in `overdue` and `dueToday`. "Open" means not completed, archived or in
the Trash. Days are in the app's time zone (`TZ`).

| Field | Meaning |
|---|---|
| `open` | Open tickets. Always `received` + `inProgress` + `waiting`. |
| `received` | Open tickets in Triage, or in the column the submit page files into. |
| `inProgress` | Open tickets anywhere else that aren't waiting. |
| `waiting` | Open tickets in the blocked column (**Settings → Board**), or blocked by an open card. Checked before `received`. These are the states the [submit page's status links](SUBMIT-PAGE.md) show. |
| `urgent` | Open tickets that count as urgent under the alert levels in **Settings → Notifications** (by default P0–P1 or S1). |
| `overdue`, `dueToday` | Open cards past their due date / due today: the same cards the [daily summary](NOTIFICATIONS.md) lists, work cards included. |
| `completedToday` | Tickets completed since midnight, archived ones included. |
| `completed7d` | Tickets completed today or in the 6 days before, archived ones included. |
| `oldestOpenDays` | Days since the oldest open ticket was created (`0` if today), or `null` when nothing is open. |
| `byPriority`, `bySeverity` | Open tickets by priority (`P0`–`P3`) and severity (`S1`–`S4`); `none` for tickets without one. Each adds up to `open`. |
| `generatedAt` | When the counts were taken (ISO 8601, UTC). |

The counts are worked out on every request, and the response is never cached. There are no CORS headers, so a web
page can't call this from the browser: dashboards have to call it from their server, which Homepage and Home
Assistant do. [AUTOMATION.md](AUTOMATION.md#dashboards) has ready-made configs.

## `POST /api/v1/cards`

Opens a ticket, or updates the open one that has the same `dedupeKey`.

**Body:** one card in the [card import format](CARD-IMPORT.md) (`format` isn't needed), plus two optional fields:

| Field | Type | Meaning |
|---|---|---|
| `title` | string, required for a new ticket | Up to 300 characters. |
| `description`, `labels`, `priority`, `severity`, `column`, `due`, `checklists`, `type`, `partOf`, `blocks`, `blockedBy`, `relatedTo`, `worklog` | | As in the [card import format](CARD-IMPORT.md#format). Nested `tickets` aren't accepted here. |
| `dedupeKey` | string, up to 200 characters | Identifies *this* problem, e.g. `backup:nightly`. While a ticket opened with the same key is still open, another `problem` adds a "Seen again" note to it instead of opening a new one. |
| `event` | `"problem"` (default) or `"resolved"` | `"resolved"` needs a `dedupeKey`. It adds a "Recovered" note to the open ticket with that key. If the token may complete tickets, it also marks the ticket done (with the default resolution reason), unless an open card still blocks it. |

**Response:** `201` for `created`, `200` otherwise.

```json
{
  "status": "created",
  "card": { "id": 42, "ticketNo": "261028-3", "title": "Nightly backup failed", "columnId": 1, "completedAt": null }
}
```

| `status` | Meaning | `card` |
|---|---|---|
| `created` | A new ticket was opened. | the new ticket |
| `updated` | A `problem` for a key that already has an open ticket: a note was added. | that ticket |
| `recovered` | A `resolved` event: a note was added and the ticket stays open (the token can't complete tickets, or a blocker is open). | that ticket |
| `resolved` | A `resolved` event: the ticket was marked done. | that ticket |
| `ignored` | A `resolved` event, but no open ticket has this key. | `null` |

`card.completedAt` is an ISO 8601 UTC timestamp, or `null`. `ticketNo` can be `null` only for cards created before
ticket numbers existed.

**Matching keys.** A key only matches tickets opened through `/api/v1/` with that key that are still open: not
completed, archived or in the Trash. Once a ticket is done, the next `problem` with the same key opens a new one.

## `POST /api/v1/hooks/uptime-kuma`

Accepts Uptime Kuma's **Webhook** notification body (the "Preset - application/json" request body) as-is, and maps
it onto `POST /api/v1/cards`:

- a monitor going **down** → a `problem` titled "*Monitor name* is down", with Kuma's message, the monitor's target
  and the time in the description;
- a monitor coming back **up** → `resolved`;
- the key is `uptime-kuma:<monitor id>`, so each monitor has at most one open ticket.

**Query parameters** (all optional) fill in the card: `labels` (comma-separated), `priority` (default `P1`),
`severity` and `column`.

**Response:** the same as `POST /api/v1/cards`. Kuma's **Test** button (a body without a monitor) answers
`{ "status": "ignored", "card": null, "test": true }` without creating anything. Pending and maintenance
notifications are `ignored`.

## Health check

`GET /health` needs no token and answers `{"status":"ok"}` while the app is up. It's useful for monitoring
Belltower itself.

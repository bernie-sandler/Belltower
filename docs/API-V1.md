# Automation API, version 1

This is the stable contract for tools and scripts that open tickets: Uptime Kuma, Unraid, Home Assistant, your own
scripts. For recipes and a gentler introduction, see [AUTOMATION.md](AUTOMATION.md).

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

Each token has one permission switch, **may complete tickets** (`canComplete`). It decides what a recovery does (see
`event` below).

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
| 413 | `too_large` | The body is over 2 MB. |
| 429 | `rate_limited` | Over 120 requests a minute. `retryAfterSec` and the `Retry-After` header say when to retry. |
| 500 | `internal` | A bug. Retrying later is reasonable. |

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

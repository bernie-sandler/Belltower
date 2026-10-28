# Card import format

A small JSON format for creating cards in bulk. It's handy with any AI chat: describe a problem, get back
ready-made cards with priorities, checklists and links. The same format is used by the
[automation API](API-V1.md) and by [Claude drafting](AI-DRAFTING.md) behind the scenes.

**Importing with an AI chat** (the page is under **Add ticket → Import from JSON** or **Menu → Import cards**; it's
offered when no `ANTHROPIC_API_KEY` is set, since with a key Claude can do this directly):

1. Press **Copy AI prompt**. It explains this format to the AI and lists your real columns and labels.
2. Paste the prompt into your AI, then describe the problem: symptoms, error messages, what you already tried.
3. Paste the AI's whole answer into the Import box. Code fences and any chatter around the JSON are ignored.
4. Press **Preview** and look over the cards, warnings and errors.
5. Press **Import**.

Nothing is created until every card in the batch is valid, so a typo never leaves you with half an import.

## Format

```json
{
  "format": "tower-tracker/cards@1",
  "cards": [
    {
      "title": "Plex transcoder crashes on 4K HDR files",
      "description": "Markdown. Transcoder exits with **code 1** when tone mapping.",
      "column": "Triage",
      "labels": ["Plex", "Hardware"],
      "priority": "P1",
      "severity": "S2",
      "due": "2026-10-30 18:00",
      "checklists": [
        { "title": "Diagnose", "items": ["Check driver version", "Try a CPU transcode"] }
      ],
      "worklog": [
        { "text": "Noticed during movie night", "at": "2026-10-09 20:15" }
      ]
    }
  ]
}
```

| Field | Required | Accepts |
|---|---|---|
| `title` | yes | Up to 300 characters. (`name` also works.) |
| `description` | no | Markdown. (`body`, `details` also work.) |
| `column` | no | A column name, case-insensitive. Unknown names fall back to Triage with a warning. Default: Triage. |
| `labels` | no | A list of names, or one comma-separated string. Existing labels match case-insensitively; new ones are created. |
| `priority` | no | `P0`–`P3`, or `critical` / `high` / `medium` / `low`, or `0`–`3`. |
| `severity` | no | `S1`–`S4`, or `blocker` / `major` / `minor` / `trivial`. |
| `due` | no | `YYYY-MM-DD`, or `YYYY-MM-DD HH:MM` (24h, your time zone). |
| `checklists` | no | `[{ "title", "items": [..] }]`. A flat `"checklist": ["step", ...]` also works. |
| `type` | no | `"ticket"` (default) or `"work"`. (`kind` also works.) A card with `tickets` is a work card. |
| `tickets` | no | Work cards only: a list of ticket cards filed under it. They use the work card's column unless they set their own. One level only. |
| `partOf` | no | Tickets only: the work card to file it under, by ticket number (`"261027-1"`, already on the board) or by the `ref` (or exact title) of a work card in the same import. |
| `ref` | no | A short name for the card, so other cards in the same import can refer to it in `partOf` or links. |
| `blocks` | no | Cards this card blocks (they can't be completed until this one is done). A list, or one value. |
| `blockedBy` | no | Cards blocking this one. (`dependsOn`, `waitingOn` also work.) A blocked card goes to the blocked column (Blocked/Waiting) like one linked by hand. |
| `relatedTo` | no | Related cards. (`related` also works.) |
| `worklog` | no | `[{ "text", "at"? }]` or plain strings. `at` is `YYYY-MM-DD HH:MM` in your time zone, or an ISO timestamp, and can't be in the future. |
| `resolution` | no | Cards created in Done only: how it was resolved, e.g. `"Fixed"`, or `{ "reason", "note" }`. Matched to your reasons ignoring case; other text is kept as written, with a warning. Ignored (with a warning) for cards in other columns. |
| `resolutionNote` | no | Markdown note for `resolution`. Without a `resolution`, the default reason is used. |

You can also paste:
- a single card object `{ "title": ... }`, or
- a bare list `[ {...}, {...} ]`.

Up to 200 cards per import.

Imported cards record "created via card import" in their history.

## Work cards and tickets

```json
{
  "format": "tower-tracker/cards@1",
  "cards": [
    {
      "type": "work",
      "title": "Upgrade Plex",
      "column": "Backlog",
      "tickets": [
        { "title": "Back up the Plex database", "priority": "P1" },
        { "title": "Test HDR playback", "column": "In Progress" }
      ]
    },
    { "title": "Prune old metadata", "partOf": "261027-1" }
  ]
}
```

## Links

`blocks`, `blockedBy` and `relatedTo` name other cards by ticket number (a card already on the board) or by the
`ref` (or exact title) of a card in the same import:

```json
[
  { "ref": "order", "title": "Order a new UPS battery" },
  { "ref": "swap", "title": "Swap the UPS battery", "blockedBy": ["order"], "relatedTo": ["261024-1"] },
  { "title": "Calibrate UPS runtime", "blockedBy": "swap" }
]
```

A link given on both cards (A `blocks` B, and B `blockedBy` A) is created once. Errors: an unknown card, a card
linked to itself, two cards blocking each other, or an open card blocking one that's done.

The preview shows nested tickets as `1.1`, `1.2` under their work card. Mistakes (an unknown `partOf`, a ticket
given `tickets`, nesting deeper than one level, a work card with a `partOf`) are reported per card, and nothing
is imported until every card is valid. Up to 200 cards per import, counting nested tickets.

## Priority and severity

Priority comes from impact × urgency:

| Impact \ Urgency | High | Medium | Low |
|---|---|---|---|
| **High** | P0 Critical | P1 High | P2 Medium |
| **Medium** | P1 High | P2 Medium | P3 Low |
| **Low** | P2 Medium | P3 Low | P3 Low |

Severity is how bad the impact is:

- **S1 Blocker**: crash, data loss, or the system is unusable
- **S2 Major**: a core function is broken
- **S3 Minor**: partial breakage or an inconvenience
- **S4 Trivial**: visual or text issues

## API

From the web UI's API: `POST /api/import/cards` with `{ "text": "<pasted text>", "dryRun": true }` returns the
preview, and `"dryRun": false` creates the cards (`201`). See [API.md](API.md). For scripts and monitoring tools,
use the stable [automation API](API-V1.md) instead, which takes one card in this format.

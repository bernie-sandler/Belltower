# Card import format

**Add ticket → Import from JSON** (or **Main menu → Import cards**) turns JSON into ready-made cards. The quickest
way to get the JSON is an AI chat. This page is only offered when `ANTHROPIC_API_KEY` isn't set; with a key, use
**Add ticket → Describe the issue** instead, which asks Claude directly.

1. On the Import cards page, press **Copy AI prompt**. The prompt describes this format and lists your real columns
   and labels.
2. Paste the prompt into your AI, then describe the problem: symptoms, error messages, what you already tried.
3. Paste the AI's whole answer into the Import box. Code fences and any chatter around the JSON are ignored.
4. Press **Preview**. Check the cards, warnings and errors.
5. Press **Import**.

Nothing is created until every card in the batch is valid.

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
| `worklog` | no | `[{ "text", "at"? }]` or plain strings. `at` is `YYYY-MM-DD HH:MM` in your time zone, or an ISO timestamp, and can't be in the future. |

You can also paste:
- a single card object `{ "title": ... }`, or
- a bare list `[ {...}, {...} ]`.

Up to 200 cards per import.

Imported cards record "created via card import" in their history.

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

`POST /api/import/cards` with `{ "text": "<pasted text>", "dryRun": true }` returns the preview. With
`"dryRun": false` it creates the cards (`201`). See [API.md](API.md).

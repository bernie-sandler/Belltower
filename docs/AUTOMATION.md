# Automation: tickets from monitoring and scripts

Tower Tracker can open tickets for you when something breaks: Uptime Kuma, Unraid notifications, Home Assistant
or any script that can send an HTTP request.

## 1. Create a token

Go to **Settings → Automation**, name the token (for example "Uptime Kuma"), then create it.

- **Copy the token straight away.** It's shown only once; only a hash is stored. It starts with `tt_`.
- **Tick "Recoveries may mark the ticket done"** if this tool should close its own tickets when the problem goes
  away. Without it, a recovery only adds a note.
- **Revoke** a token in the same place. Anything using it stops working at once.

Every request sends the token in a header:

```
Authorization: Bearer tt_…
```

The `/api/v1` addresses accept only tokens: no password, cookies or other headers. Each token can make 120
requests a minute.

## 2. Open a ticket: `POST /api/v1/cards`

The body is one card in the [card import format](CARD-IMPORT.md). Only `title` is required. You can also give:

- `description`, `labels`, `priority`, `severity`, `column` and `due`;
- `type` and `partOf`, to file it under a work card;
- `blocks`, `blockedBy` and `relatedTo`, to link it.

Two more fields:

| Field | |
|---|---|
| `dedupeKey` | Any text that identifies *this* problem, e.g. `nas-offline` or `backup:nightly`. While a ticket opened with this key is still open, sending it again adds a "Seen again" note to that ticket instead of opening another. |
| `event` | `"problem"` (default) or `"resolved"`. `"resolved"` with the same `dedupeKey` adds a "Recovered" note. If the token may complete tickets, it also marks the ticket done (unless an open card still blocks it). |

```bash
curl -X POST https://tower.example.com/api/v1/cards \
  -H "Authorization: Bearer tt_…" \
  -H "Content-Type: application/json" \
  -d '{"title": "Nightly backup failed", "priority": "P1", "labels": ["Backups"], "dedupeKey": "backup:nightly",
       "description": "rsync exited with code 23"}'
```

**The reply** is JSON with a `status` and the `card` (`id`, `ticketNo`, `title`, `columnId`, `completedAt`):

| Status | When |
|---|---|
| `created` | A new ticket was opened (HTTP 201). |
| `updated` | An open ticket with this `dedupeKey` got a note. |
| `recovered` | `"resolved"`: a note was added; the ticket stays open. |
| `resolved` | `"resolved"`: the ticket was marked done. |
| `ignored` | `"resolved"`, but no open ticket has this key. |

A card that doesn't validate returns `400` with the reasons in `errors`.

## Uptime Kuma

1. In Uptime Kuma, go to **Settings → Notifications → Setup Notification**.
2. Set **Notification Type** to **Webhook**.
3. Set **Post URL** to
   `https://tower.example.com/api/v1/hooks/uptime-kuma?labels=Monitoring&priority=P1`.
   The query is optional: `labels` (comma-separated), `priority`, `severity` and `column`. The default priority is
   P1.
4. Set **Request Body** to **Preset - application/json**.
5. Turn on **Additional Headers** and enter `{ "Authorization": "Bearer tt_…" }`.
6. Press **Test**. It answers without creating a ticket.
7. Turn the notification on for the monitors you want.

When a monitor goes **down**, a ticket "*Name* is down" opens, holding Kuma's message and the monitor's URL. Further
down alerts for the same monitor add notes. When it comes back **up**, the ticket gets a "Recovered" note, or is
marked done if the token allows it.

## Unraid notifications

Unraid can run a script for each notification. A simple agent:

```bash
#!/bin/bash
# $SUBJECT, $DESCRIPTION, $IMPORTANCE come from Unraid.
PRIORITY=P2; [ "$IMPORTANCE" = "alert" ] && PRIORITY=P1
curl -s -X POST http://tower:8080/api/v1/cards \
  -H "Authorization: Bearer tt_…" -H "Content-Type: application/json" \
  -d "$(jq -n --arg t "$SUBJECT" --arg d "$DESCRIPTION" --arg p "$PRIORITY" \
        '{title: $t, description: $d, priority: $p, labels: ["Unraid OS"], dedupeKey: ("unraid:" + $t)}')"
```

`jq` builds the JSON so quotes in messages can't break it.

## Home Assistant

```yaml
rest_command:
  tower_ticket:
    url: http://tower:8080/api/v1/cards
    method: POST
    headers:
      Authorization: !secret tower_tracker_token   # "Bearer tt_…"
    content_type: application/json
    payload: '{"title": "{{ title }}", "description": "{{ message }}", "dedupeKey": "{{ key }}", "labels": ["Home Assistant"]}'
```

Call it from an automation with `service: rest_command.tower_ticket` and `data: { title: …, message: …, key: … }`.

## If a tool can't reach it

**Timeouts from another machine** (Uptime Kuma: "timeout of 48000ms exceeded") mean the request never reached
Tower Tracker.
- **Wrong address.** Use the address of the machine running the app, as seen from the tool, such as
  `http://192.168.1.50:8080` or a Tailscale name. `localhost` and `127.0.0.1` only work on that machine itself.
- **Windows firewall** (when the app runs in Docker Desktop on a Windows PC). Windows blocks incoming connections
  on networks marked **Public**. Do one of these:
  - Mark your home network as Private: **Settings → Network & internet → *your connection* → Network profile type
    → Private**.
  - Allow the port, in an administrator PowerShell:
    ```powershell
    New-NetFirewallRule -DisplayName "Tower Tracker 8080" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow -Profile Private
    ```
  - Add `-Profile Any` instead if the network has to stay Public.
- **Test from the other machine** first:
  ```bash
  curl http://192.168.1.50:8080/health
  ```
  It should answer `{"status":"ok"}`.

**`401 Send a valid API token`.** The header is missing, or the token was revoked or mistyped. It must be exactly
`Authorization: Bearer tt_…`.

**On Windows, use PowerShell's own command.** The curl example above is for Linux, macOS and Unraid shells; its `\`
line breaks and single quotes don't work in PowerShell.

```powershell
Invoke-RestMethod -Method Post -Uri "http://192.168.1.50:8080/api/v1/cards" `
  -Headers @{ Authorization = "Bearer tt_…" } -ContentType "application/json" `
  -Body '{"title": "Backup failed", "priority": "P1", "dedupeKey": "nightly-backup"}'
```

## Good to know

- **Where tickets land.** Tickets from tokens are created like any other card: in Triage unless `column` says
  otherwise, with history noting `API token "Uptime Kuma"`.
- **Discord.** If notifications are on (**Settings → Discord notifications**), new tickets from automation
  announce themselves.
- **Exposing it through a reverse proxy.** Prefer pointing tools at the app on your LAN or tailnet. If you do expose
  it, `/api/v1/*` can be allowed through on its own; tokens are the only way in.

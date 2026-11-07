# Automation: tickets from monitoring and scripts

The best ticket is the one you didn't have to write. Belltower can open tickets for you when something breaks:
from Uptime Kuma, Unraid's notifications, Home Assistant, or any script that can send an HTTP request.

It's built for noisy monitors. A flapping service updates one ticket instead of opening twenty, and when the
problem goes away the ticket can close itself.

The exact rules are in [API-V1.md](API-V1.md); this page is the friendly version.

## 1. Create a token

Go to **Settings → Automation**, give the token a name (say "Uptime Kuma"), and create it.

- **Copy it straight away.** It's shown once; the app only keeps a hash. It starts with `tt_`.
- **Tick "Recoveries may mark the ticket done"** if this tool should close its own tickets when things recover.
  Without it, a recovery just adds a note and leaves closing to you.
- To stop a tool, **revoke** its token in the same place. It stops working immediately.

Every request carries the token in a header:

```
Authorization: Bearer tt_…
```

One token per tool is a good habit: the ticket history then shows which tool opened what.

## 2. Open a ticket

Send one card to `POST /api/v1/cards`. The body uses the [card import format](CARD-IMPORT.md); only `title` is
required, and you can add `description`, `labels`, `priority`, `severity`, `column`, `due`, links and so on.

Two extra fields make it automation-friendly:

- **`dedupeKey`** names the problem, like `backup:nightly` or `nas-offline`. While a ticket with that key is open,
  repeats add a "Seen again" note instead of a new ticket.
- **`event`** is `"problem"` (the default) or `"resolved"`. A `"resolved"` with the same key adds a "Recovered"
  note. If the token is allowed to, it also marks the ticket done, recording the default resolution reason.

```bash
curl -X POST http://tower:8080/api/v1/cards \
  -H "Authorization: Bearer tt_…" \
  -H "Content-Type: application/json" \
  -d '{"title": "Nightly backup failed", "priority": "P1", "labels": ["Backups"],
       "dedupeKey": "backup:nightly", "description": "rsync exited with code 23"}'
```

The reply tells you what happened (`created`, `updated`, `recovered`, `resolved` or `ignored`) and which ticket it
touched. A card that doesn't validate gets a `400` listing every problem.

## Uptime Kuma

Kuma has its own hook, so there's no JSON to write.

1. In Uptime Kuma, go to **Settings → Notifications → Setup Notification**.
2. Set **Notification Type** to **Webhook**.
3. Set **Post URL** to
   `http://tower:8080/api/v1/hooks/uptime-kuma?labels=Monitoring&priority=P1`.
   Everything after `?` is optional: `labels` (comma-separated), `priority` (P1 if left out), `severity` and
   `column`.
4. Set **Request Body** to **Preset - application/json**.
5. Turn on **Additional Headers** and enter `{ "Authorization": "Bearer tt_…" }`.
6. Press **Test**. It answers without creating a ticket.
7. Turn the notification on for the monitors you care about.

When a monitor goes **down**, you get a ticket "*Name* is down" with Kuma's message and the monitor's address. More
down alerts for the same monitor add notes to it. When it comes back **up**, the ticket gets a "Recovered" note, or
closes itself if the token allows that.

## Unraid notifications

Unraid can run a script for each notification. Here's a small agent:

```bash
#!/bin/bash
# $SUBJECT, $DESCRIPTION, $IMPORTANCE come from Unraid.
PRIORITY=P2; [ "$IMPORTANCE" = "alert" ] && PRIORITY=P1
curl -s -X POST http://tower:8080/api/v1/cards \
  -H "Authorization: Bearer tt_…" -H "Content-Type: application/json" \
  -d "$(jq -n --arg t "$SUBJECT" --arg d "$DESCRIPTION" --arg p "$PRIORITY" \
        '{title: $t, description: $d, priority: $p, labels: ["Unraid OS"], dedupeKey: ("unraid:" + $t)}')"
```

`jq` builds the JSON, so quotes in a message can't break it.

To install it:

1. Create a token named "Unraid" (see [step 1](#1-create-a-token)).
2. In the Unraid terminal, save the script as an agent on the flash drive:

   ```bash
   mkdir -p /boot/config/plugins/dynamix/notifications/agents
   nano /boot/config/plugins/dynamix/notifications/agents/Belltower.sh
   ```

   Put your token in place of `tt_…`. The script runs on Unraid itself, so `http://localhost:8080` works as the
   address. Unraid runs agents with `bash`, so the file doesn't need to be executable.
3. Check `jq` is there with `which jq`. Recent Unraid releases include it.
4. In **Settings → Notification Settings**, tick **Agents** for the levels that should open tickets. Warnings and
   Alerts is a good start; Notices are mostly routine.
5. Send a test alert. A P1 card "Belltower test" should appear in Triage:

   ```bash
   /usr/local/emhttp/webGui/scripts/notify -e "Test" -s "Belltower test" -d "Hello from Unraid" -i "alert"
   ```

Unraid never sends a recovery, so these tickets don't close themselves. The subject is the dedupe key: a subject
that changes each time (a temperature, say) opens a new ticket each time. Custom agents aren't an official Unraid
feature, so re-run the test after big Unraid upgrades.

## Home Assistant

```yaml
rest_command:
  tower_ticket:
    url: http://tower:8080/api/v1/cards
    method: POST
    headers:
      Authorization: !secret belltower_token   # "Bearer tt_…"
    content_type: application/json
    payload: '{"title": "{{ title }}", "description": "{{ message }}", "dedupeKey": "{{ key }}", "labels": ["Home Assistant"]}'
```

Call it from an automation with `service: rest_command.tower_ticket` and `data: { title: …, message: …, key: … }`.

## From Windows (PowerShell)

The curl example above is for Linux, macOS and the Unraid shell; its `\` line breaks and single quotes don't work in
PowerShell. Use PowerShell's own command instead:

```powershell
Invoke-RestMethod -Method Post -Uri "http://192.168.1.50:8080/api/v1/cards" `
  -Headers @{ Authorization = "Bearer tt_…" } -ContentType "application/json" `
  -Body '{"title": "Backup failed", "priority": "P1", "dedupeKey": "nightly-backup"}'
```

## If a tool can't reach it

**It times out** (Uptime Kuma says something like "timeout of 48000ms exceeded"). The request never reached
Belltower. Check these:

- **The address.** Use the address of the machine running the app *as the tool sees it*, such as
  `http://192.168.1.50:8080` or a Tailscale name. `localhost` only works on that machine itself.
- **The Windows firewall**, if the app runs in Docker Desktop on a Windows PC. Windows blocks incoming connections on
  networks marked **Public**. Either mark your home network as Private (**Settings → Network & internet → *your
  connection* → Network profile type → Private**), or allow the port in an administrator PowerShell:

  ```powershell
  New-NetFirewallRule -DisplayName "Belltower 8080" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow -Profile Private
  ```

  (Use `-Profile Any` if the network has to stay Public.)
- **Test from the other machine** before blaming the tool:

  ```bash
  curl http://192.168.1.50:8080/health
  ```

  It should answer `{"status":"ok"}`.

**`401` "Send an API token".** The header is missing, mistyped, or the token was revoked. It has to be exactly
`Authorization: Bearer tt_…`.

**`429`.** More than 120 requests a minute from one token. A monitor stuck in a loop, usually. It's told when to
retry.

## Good to know

- Automated tickets are ordinary cards: in Triage unless `column` says otherwise, with "API token *name*" in their
  history.
- With [Discord notifications](NOTIFICATIONS.md) on, new tickets from automation are announced.
- Point tools at the app on your LAN or tailnet if you can. If you must expose it through a reverse proxy, `/api/v1/`
  can be let through on its own; tokens are the only way in.

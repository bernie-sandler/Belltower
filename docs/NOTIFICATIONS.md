# Discord notifications

Belltower can post to a Discord channel, so the things that matter find you instead of waiting for you to open
the board.

## Setting it up

1. In Discord, open the channel's settings and go to **Integrations → Webhooks → New Webhook**. Copy its URL.
2. In Belltower, go to **Settings → Discord notifications** and paste the URL.
3. Pick what to announce (below), then press **Send test**.

Only Discord webhook addresses are accepted, so the app can't be pointed anywhere else. The saved address is never
shown in full again, only a hint of its ending.

## What it can announce

- **New tickets from outside:** from the [submit page](SUBMIT-PAGE.md) or [automation](AUTOMATION.md). Cards you
  create yourself aren't announced; you already know about those.
- **Urgent cards:** created urgent, or raised to urgent later. By default "urgent" means P0–P1 priority or S1
  severity; you can change either threshold.
- **A card got blocked.**
- **A daily summary** of what's overdue and what's due today, at a time you pick. If nothing is due, you get a
  short all-clear instead of silence, so you know it's still working.

**Send summary now** sends today's summary straight away, handy for checking the format. The page also shows the
result of the last delivery, so a broken webhook doesn't go unnoticed.

## What's sent

The card's ticket number and title, its column, priority and severity, where it came from (for outside tickets,
for example "submit page (Sam)"), and a link back to the card if you've set the app's address under **Settings →
General**. Descriptions, work logs and attachments are never sent.

## Not working?

- Press **Send test** and read the result shown under it. Discord's own error message is passed along.
- A summary missed during an outage isn't lost: the app tries again on the next check, and a failed send doesn't
  count as sent.
- The server needs to reach `discord.com` over the internet.

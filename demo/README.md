# Try Belltower

See what Belltower is like before installing it. This runs the published image on your own machine, with a board
that already looks lived in, and removes cleanly when you're done. All you need is Docker.

```bash
git clone --depth 1 https://github.com/bernie-sandler/Belltower.git
cd Belltower/demo
docker compose up -d
```

Give it a few seconds to add the sample tickets, then open <http://127.0.0.1:8088> and sign in with the password
`belltower-demo`.

Port 8088 taken? Run `DEMO_PORT=8099 docker compose up -d` instead, or put `DEMO_PORT=8099` in a `.env` file in this
folder (which works on Windows too).

## What to look at

The board belongs to someone running a home server, with a drive going bad, a certificate that won't renew and a Plex
upgrade under way. It's all sample data, so change anything you like.

- **Open "Disk 3 reallocated sectors climbing".** This is the everyday use: a ticket you wrote yourself, with a
  half-finished checklist, a work log of what you tried and when, and a SMART report attached.
- **Open "Upgrade Plex".** A work card keeps the tickets of a bigger job together. Its finished ticket sits in Done,
  and the one still waiting shows up under a folder header in Blocked/Waiting.
- **Try to finish "Swap the UPS battery".** You can't, because "Order a new UPS battery" blocks it. Mark the order done
  and the swap is free to go.
- **Search for `bonding`.** You'll find an archived ticket and the note on how it was fixed. This is the point of keeping
  records: the answer is there when it happens again.
- **Open the calendar** to see what's due, what got done and when work was logged.
- **Look in Triage** for tickets you didn't write. One came through the submit page, one from Uptime Kuma (its second
  alert added a note instead of a duplicate), and one from a recurring maintenance template.
- **Open the submit page** to see what other people get. The link is under **Settings → Submit page**, and no sign-in
  is needed.

Discord notifications and Claude drafting are off here, since both need something of your own (a webhook, an API key).
See [Discord notifications](../docs/NOTIFICATIONS.md) and [Claude drafting](../docs/AI-DRAFTING.md) for what they do.

## Start over or clean up

Run these from this folder. They only touch the demo: it has its own container and data volume, even if you run a real
Belltower on the same machine.

To go back to a fresh board, with dates that match today again:

```bash
docker compose down -v
docker compose up -d
```

To remove it:

```bash
docker compose down -v
```

To pause it and keep your changes, use `docker compose stop`, then `docker compose start` to pick up again. It doesn't
come back by itself after a reboot.

To see the newest release, run `docker compose pull` before `up`. To see a particular one, set `DEMO_VERSION` the same
way as `DEMO_PORT`, for example `DEMO_VERSION=1.2.2`. Images go back to 1.2.0.

## Not for real use

The password is written right here, so the demo only listens on your own machine. Don't open it up to your network or
put your real tickets in it. When you're ready for the real thing, follow [the install guide](../docs/INSTALL.md).

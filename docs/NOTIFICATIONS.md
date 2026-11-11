# Notifications

Belltower can tell you when something needs you, so the things that matter find you instead of waiting for you to
open the board. It can post to **Discord**, push to your phone through **ntfy** or **Gotify**, or send a JSON message
to any **webhook** (Home Assistant, n8n, your own script). Use one or all of them.

Everything is under **Settings → Notifications**. Nothing goes out through a channel until it's set up.

Since 1.5 each person also gets their own notifications, about their own cards: a bell in the app, and if they want,
a Discord mention or a push to their own ntfy topic. They come with **Teams** (Settings → General), which is off until
an admin turns it on. See [Personal notifications](#personal-notifications) below, and
[With Teams off](#with-teams-off) for what a solo install gets.

## What it can announce

Each channel has its own checkboxes, so you might send everything to Discord and only urgent cards to your phone.

- **New tickets from outside:** from the [submit page](SUBMIT-PAGE.md) or [automation](AUTOMATION.md). Cards you
  create yourself aren't announced; you already know about those.
- **Urgent cards:** created urgent, or raised to urgent later. By default "urgent" means P0–P1 priority or S1
  severity.
- **A card got blocked.**
- **A daily summary** of what's overdue and what's due today. If nothing is due, you get a short all-clear instead of
  silence, so you know it's still working.

A new urgent ticket from outside counts once: as a new outside ticket on channels that announce those, and as an
urgent card on channels that only want urgent ones.

**Shared by every channel:** what "urgent" means (the priority and severity thresholds) and when the daily summary
goes out.

## Setting up a channel

Open the channel's panel, fill it in, tick what it should announce, then press **Save** and **Send test**. The panel
shows the result of the last delivery, so a broken channel doesn't go unnoticed. **Send summary now** sends today's
summary straight away, which is handy for checking the format.

Saved addresses and tokens are never shown again, only a hint like `https://ntfy.sh/…`. To change one, paste a new
one. **Remove** next to a token removes just the token. If you point a channel at a different server, port or scheme
(`https` to `http` included), its saved token or secret is forgotten unless you enter a new one at the same time.
Tokens can only contain letters, digits and plain punctuation, with no spaces.

### Discord

1. In Discord, open the channel's settings and go to **Integrations → Webhooks → New Webhook**. Copy its URL.
2. Paste it into **Webhook URL**.

Only Discord webhook addresses are accepted here.

### ntfy

1. Pick a topic on [ntfy.sh](https://ntfy.sh) or your own ntfy server, and subscribe to it in the ntfy app. On ntfy.sh
   anyone who knows a topic's name can read it, so use a long random name.
2. Paste the topic's address into **Topic address**, for example `https://ntfy.sh/belltower-x7Kq2v9`. A server under a
   sub-path works too: `https://example.com/ntfy/belltower`.
3. If the topic is protected, paste an **access token** (`tk_…`). An address with `?auth=…` works too.

Urgent cards arrive with ntfy's top priority (5), everything else with the default (3). Tapping a notification opens
the card, if the app's address is set under **Settings → General**.

### Gotify

1. In Gotify, go to **Apps → Create Application** and copy its token.
2. Paste your Gotify server's address into **Server address** (a sub-path like `https://example.com/gotify` works) and
   the token into **App token**.

Urgent cards are sent with priority 8, everything else with 5. Messages use Markdown and open the card when tapped.

### Webhook

Paste the address that should receive the messages. A **signing secret** is optional. With one, every request carries
a signature so the receiver can check it really came from your Belltower.

Every message is a `POST` with a JSON body:

```json
{
  "version": 1,
  "event": "new_urgent",
  "title": "261028-3 — Disk 3 SMART errors",
  "message": "New urgent card (P1 High)",
  "urgent": true,
  "url": "https://tower.example/cards/42",
  "card": {
    "id": 42,
    "ticketNo": "261028-3",
    "title": "Disk 3 SMART errors",
    "kind": "ticket",
    "column": "Triage",
    "priority": "P1",
    "severity": null,
    "dueDate": null,
    "url": "https://tower.example/cards/42"
  },
  "sentAt": "2026-10-28T19:04:05.123Z"
}
```

| Field | Meaning |
|---|---|
| `version` | Always `1` within Belltower 1.x. |
| `event` | `new_external`, `new_urgent`, `raised`, `blocked`, `digest` or `test`. No others appear in 1.x. |
| `title` | The card's ticket number and title, `Belltower: today` for the summary, or `Belltower test message`. |
| `message` | What happened, in a sentence. |
| `urgent` | Whether the card counts as urgent under the current alert levels, on every card event. `false` for `digest` and `test`. |
| `url`, `card.url` | A link to the card, or `null` if the app's address isn't set. |
| `card` | The card, or `null` for `digest` and `test`. `priority` is `P0`–`P3` or `null`; `severity` is `S1`–`S4` or `null`; `kind` is `ticket` or `work`. |
| `digest` | Only for `digest`: `{ "overdue": [card…], "dueToday": [card…] }`, with cards in the same shape as `card`. |
| `sentAt` | When it was sent (ISO 8601, UTC). |

New fields may be added within 1.x; ignore the ones you don't know. Descriptions, work logs and attachments are never
sent.

**Headers**

| Header | Meaning |
|---|---|
| `X-Belltower-Event` | The same as `event`. |
| `X-Belltower-Delivery` | A unique id per message. It stays the same across the immediate retries of one delivery, so you can drop duplicates. A daily summary tried again 30 minutes later is a new delivery with a new id. |
| `X-Belltower-Timestamp` | Unix time in seconds when it was sent. |
| `X-Belltower-Signature` | Only with a signing secret: `sha256=` followed by the hex HMAC-SHA256 of `<timestamp>.<body>`, keyed with the secret. |

To check a signature, compute the HMAC over the timestamp header, a dot and the raw body exactly as received, then
compare it with the header in constant time. Rejecting timestamps more than a few minutes old stops replays. In
Node.js:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function fromBelltower(rawBody, headers, secret) {
  const ts = headers['x-belltower-timestamp'];
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex')}`;
  const got = headers['x-belltower-signature'] ?? '';
  return got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}
```

Any `2xx` answer counts as delivered.

## What's sent

The card's ticket number and title, its column, priority and severity, where it came from (for outside tickets, for
example "submit page (Sam)"), and a link back to the card if you've set the app's address under **Settings →
General**. Descriptions, work logs and attachments are never sent.

In ntfy and Gotify, which show messages as Markdown, text that comes from other people (a submitter's name, ticket
titles) has Markdown characters escaped, so it can't add images or disguised links.

## Personal notifications

These come with **Teams** (Settings → General, see [USING.md](USING.md#teams)); for a solo install, see
[With Teams off](#with-teams-off). Each person decides what reaches them under **Account → Notifications**. These are
separate from the install's channels above: the events, the webhook's payload and its `event` names don't change, and
nothing personal is ever sent to the webhook, Gotify or the install's own ntfy topic.

**What notifies you**

- **Assigned:** a card is assigned to you.
- **Mentioned:** someone writes `@yourusername` in a work-log note. Mentions in code (`` `like this` `` or a fenced
  block, or an indented code block), email addresses and an escaped `\@name` don't count. Editing a note only tells
  people it didn't mention before, and a retracted note tells nobody (its notifications leave the bell until it's
  restored). Notes that come with imported cards ([card import](CARD-IMPORT.md), a new ticket from
  [automation](AUTOMATION.md)) are history and tell nobody.
- **Cards you watch:** a new note, a move (done and reopened included) or a new assignee. You watch a card when you
  create it in the app, are assigned it, are mentioned on it or write a note on it; **Watch** in the card's header
  turns it on or off.
- **New tickets nobody has:** a ticket arrives from the submit page or an API token with nobody assigned. Off unless
  you turn it on.
- **New tickets from the submit page:** someone without an account filed a ticket on the [submit page](SUBMIT-PAGE.md)
  (tickets from API tokens and monitors don't count). In the app for admins by default, off for members. When both
  this and "New tickets nobody has" apply to the same ticket, you're told once, as a submit-page ticket.

You're never told about what you did yourself, but something an API token of yours did does reach you. Deactivated
people get nothing.

**Where it goes.** Each event has three boxes: **In the app** (the bell), **Discord** and **ntfy**. The bell is on by
default for the first three events, and for submit-page tickets if you're an admin; everything else is opt-in.

- **The bell** in the top bar shows how many you haven't read. Opening one opens its card and marks it read (so does
  opening the card any other way), and **Mark all read** clears the count. Screen readers announce what's new. It checks every 30 seconds, also in a background tab, and when you come back to
  the tab. It can play a sound (chime, ping or off), chosen per device under **Settings → Appearance**; only one open
  tab plays it, and only for something new, not for what was there when the page loaded. Browsers allow sound only
  after you've clicked or typed on the page.
- **Discord** posts in the install's Discord channel and mentions you there, and only you (a webhook can't send direct
  messages, so others in the channel see it too). Fill in your **Discord user ID**: in Discord, turn on **Settings →
  Advanced → Developer Mode**, then right-click your name and choose **Copy User ID** (17 to 20 digits). Belltower
  can't check that the ID is yours, so anyone could enter someone else's; the mention still only ever appears in the
  install's own channel, so it can only ping people who are in that channel anyway.
- **ntfy** publishes to your own topic, on the server of the install's ntfy channel and with its access token. Fill in
  a **topic** that starts with `belltower-` (or press **Random topic**) and subscribe to it in the ntfy app on that
  server. The install's own topic isn't accepted.

Discord and ntfy need the install's channel to be set up first (above); until then the Account page says so and their
boxes stay off. **Send me a test** sends one message to each channel you've filled in, so you can check before
waiting for something real.

**Several at once.** Changes for one person within about 5 seconds go out together, as one Discord message and one
ntfy message ("3 updates in Belltower"), so moving a whole folder of tickets doesn't flood you or hit Discord's limit
of 30 messages a minute per webhook.

**ntfy topics work like passwords.** On ntfy.sh, and on any server that doesn't require access tokens, anyone who
knows a topic's name can read it and post to it. Use a long random name (that's what **Random topic** makes), don't
reuse it elsewhere, and pick a new one if it leaks.

**On an ntfy server with access control,** the install's token sends everyone's personal messages. Personal topics
always start with `belltower-`, so give that token write access to `belltower-*` (as well as the install's own topic)
and nothing more, for example `ntfy access <token's user> 'belltower-*' write-only`. That way nobody can make
Belltower post to any other topic on your server. Without the access, ntfy answers 403, and **Send me a test** says
so.

**What's sent:** what happened ("Alex Chen mentioned you: …", with the start of the note for notes and mentions), the
card's ticket number and title, and a link to the card if the app's address is set under **Settings → General**.
Text from other people is escaped, so it can't add formatting, links or extra Discord mentions.

## With Teams off

Teams is off on a new install and after upgrading, so a solo install has no assignees, watching or mentions to hear
about. One thing still reaches you: **a new ticket from the [submit page](SUBMIT-PAGE.md)**.

- Every active admin gets it in the bell, whatever they chose under Account → Notifications (which is hidden while
  Teams is off). Members get nothing.
- The bell, and its sound under Settings → Appearance, show only while the submit page is on, and only to admins. It
  lists only these; anything from before Teams was turned off waits, unread, for when it's back on.
- Nothing personal goes to Discord or ntfy. The install's own channels above already announce new tickets from
  outside, exactly as they do with Teams on.
- Nothing else is written while Teams is off, so turning it back on doesn't bring a pile of old news.

## Not working?

- Press **Send test** and read the result in the panel. For Discord, its error message is passed along. For the other
  channels you see only the status code ("ntfy answered 403") or why the server couldn't be reached
  ("ECONNREFUSED"), never the response itself.
- Each attempt waits up to 10 seconds for an answer. A failed message is retried twice (not after a `4xx` other than
  `429`, a redirect or a blocked port). A `429` (too many requests) waits as long as the server asks, up to 30
  seconds.
- **Redirects aren't followed.** If the address redirects (for example `http://` to `https://`), use the final
  address.
- A daily summary missed during an outage isn't lost. A channel that failed tries again 30 minutes later, and channels
  that worked aren't sent it twice.
- The server needs to reach the channel: `discord.com` and `ntfy.sh` over the internet, or your own servers on your
  network.

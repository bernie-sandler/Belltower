# The submit page

Sooner or later someone tells you "Plex is broken" in a text message, and the details get lost. The submit page is a
link you can hand out so family, friends or players can file a proper ticket themselves, without your password and
without seeing anything else on your board.

## Turning it on

1. Go to **Settings → Submit page** and switch it on.
2. Copy the link it shows. It looks like `…/submit/<long random key>`.
3. Share it however you like: pinned in a Discord channel, in the family group chat, on a note by the TV.

## What people see

A short form:

1. **What do you need help with?** They pick a request type, such as General, Plex or Game servers.
2. **That type's questions:** for example "Which server?" or "What were you watching?".
3. A title and "what's wrong", plus any tags you allow, up to 3 screenshots, and their name.

When they send it, they get the new ticket's number and nothing else. They never see your board.

On your side it's a normal card in Triage (or the column you choose). Their answers are added below the description,
the title follows the type's pattern (say "Plex – Interstellar – stutters"), and the history notes
"submit page (*their name*)". With [Discord](NOTIFICATIONS.md) set up, you get a message for each one.

## Request types

You start with **General**, **Plex** and **Game servers**, based on the old Discord support templates. Each type has
its own questions. You can edit, reorder, switch off or add types, and each question can be:

- short or long text;
- pick one, or pick several;
- a date and time;
- yes or no.

A type's **title pattern** builds the ticket title from the answers. `{summary}` is the title they typed, and
`{question_key}` is any of the type's questions.

## Keeping it tidy

- **A new link** (**New link** in Settings) replaces the old address instantly. Use it if the link ends up somewhere
  you didn't intend.
- **Limits:** each address can send 5 tickets per 10 minutes, and the page takes 30 per hour overall.
- Screenshots must be real images. A hidden field quietly catches simple spam bots.
- A wrong or old link just says "This page doesn't exist".

## Sharing it outside your network

If the link has to work beyond your LAN and tailnet (say, for players), publish it through
[Nginx Proxy Manager](REMOTE-ACCESS.md#option-b-an-https-name-through-nginx-proxy-manager) but let **only** the
submit page through. Everything else stays behind your access list.

The paths it needs are `/submit/`, `/api/public/` and `/assets/`. The icons at the site root are optional. One way to
do it is a custom location for `/submit`, `/api/public` and `/assets` on the same proxy host without the access list.

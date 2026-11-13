# Using Belltower

A quick tour. Most of it you'll figure out by clicking around; this covers the parts that aren't obvious.

## The board

Cards flow left to right: **Triage → Backlog → In Progress → Blocked/Waiting → Done**. Rename, add or reorder
columns from a column's **⋯** menu. Triage and Done have special jobs (new cards land in Triage; Done is where
finished cards go), so they can be renamed but not removed.

Moving a card:
- **Drag it** with the mouse, or long-press and drag on a phone.
- **Keyboard:** focus a card, press `Space` to pick it up, use the arrow keys, and press `Space` again to drop it.
  Screen readers announce each step.
- **Move to…** in the card (or its **⋯** menu) picks a column and puts the card at the top or bottom.

The filter bar narrows the board by text, label, priority, severity, due date or (with [Teams](#teams) on) assignee.

Done shows the 50 most recently finished cards. Older ones are a click away (**Show N older cards**), and **Archive
all cards…** in the column menu clears Done out completely. Archived cards stay searchable.

## Cards

Every card gets a **ticket number** when it's created: today's date plus a counter, like `261024-1`. The format is
yours to change in Settings; existing numbers never change.

Inside a card you'll find:

- **Priority** (P0–P3) and **severity** (S1–S4). Unsure about priority? The helper next to it asks how much is
  affected (impact) and how soon it matters (urgency), and works it out.
- A **Markdown description** and a **due date** (with an optional time).
- **Checklists** for the steps. Click an item to cycle its mark: ✓ done, ✗ failed (or "no" to a yes/no question),
  ~ couldn't verify or still in progress, then back to empty. ✓ and ✗ count toward progress, and the card's badge on
  the board turns red for any ✗ and yellow for any ~, so a failure doesn't hide behind "5/5".
- **Attachments.** Drag files in, paste a screenshot, or pick a file. Images show inline and logs open in a viewer.
- **Linked cards:** "related to", "blocks" or "blocked by". A card that's blocked by an open card moves to
  Blocked/Waiting by itself, and it can't be marked done until the blocker is.
- **Labels**, managed from the main menu.

### Work cards

Some cards are a *piece of work* rather than a single problem: "Upgrade Plex", "Move to 10GbE". Make one a **work
card** (the type switch at the top of a card) and file tickets under it, like a folder.

On the board, a work card's tickets stay together under it in every column, and the group folds up when you don't
need to see it. **Mark done** on a work card offers to finish all of its tickets at once (not while any of them is
blocked).

Tickets whose work card is in another column sit under a folder header. **Drag the header** to another column and
all its tickets move with it, folded or not. On a phone, long-press it first. With the keyboard, focus it, press
`Space`, use the left and right arrow keys, and press `Space` again to drop it.

A folder moves all at once or not at all. If one ticket is blocked and you're dragging into Done, or one went to the
Trash on another device, nothing moves and a message tells you which. With a filter on, only the tickets you can see
move.

### Closing a card

**Mark done** asks how it ended: **Fixed**, **Won't fix**, **Duplicate**, **Can't reproduce** or **No longer
needed** (edit that list in Settings), with an optional note. Press Enter to accept the default.

That note is gold six months later. "How did I fix this last time?" is a search away. If you drag a card into Done
instead, a toast offers **Add resolution**, and a done card's **Resolution** section can be edited any time. The
board shows a small badge when a card ended as anything other than the default.

## Teams

Belltower works for one person or for several. The features for working together are behind one switch,
**Settings → General → Teams**, which is off until an admin turns it on, so a solo install looks as it always did
(an install that already had several people when it moved to 1.5.0 starts with it on):

- **assignees**: the Assignee field on cards, initials on tiles, the filter's Assignee group, and the **Mine** and
  **Unassigned** pages (see [Who has what](#who-has-what));
- **watching**, **@mentions** and **the bell** (see [Watching, mentions and the bell](#watching-mentions-and-the-bell)),
  with its sound under Settings → Appearance and **Account → Notifications**;
- **people's names in the history** and on work-log notes.

With Teams off all of that is hidden, and nothing is deleted: assignments, watches and notifications are kept (the API
can still set them), and turning Teams back on brings everything back as it was. `@name` in a note is plain text, so it
doesn't make anyone watch the card. Turning Teams off while other people have accounts asks first, since it hides the
features for everyone and stops their personal Discord and ntfy messages. Accounts, signing in, **Settings → People**,
your **Account** (profile, password, tokens, sign-in) and [single sign-on](SSO.md) work either way. Entries in the
history still say when something came through an API token, the submit page, a recurring template or card import, just
without the person's name.

**One thing still notifies with Teams off:** a new ticket from the [submit page](SUBMIT-PAGE.md). Admins get it in the
bell, which shows (to admins) only while the submit page is on, and lists nothing else. See
[NOTIFICATIONS.md](NOTIFICATIONS.md#with-teams-off).

## Who has what

*With [Teams](#teams) on.* A card can be **assigned** to one person: pick them under **Assignee** in the card, or press
**Assign to me**. Their initials show on the card's tile (hover for the full name). Deactivated people can't be given
cards; one who still has a card keeps it until someone changes it.

Two pages in the top bar sort out the work:

- **Mine** lists your open cards, most urgent first.
- **Unassigned** is the queue: every open card nobody has, from any column, most urgent first and then oldest.
  **Take it** gives the card to you. If someone else took it a moment before you, you're told who, and it stays
  theirs.

Both leave out finished cards (and, like the board, archived cards and the Trash). On the board, the filter's
**Assignee** group shows your cards, unassigned ones, or someone else's. It's kept in the address
(`?assignee=me`), so a bookmark works.

## History and the work log

Every change to a card is recorded automatically: moves, edits, labels, links, assignments, resolutions. The history
can't be edited or deleted, by design. With [Teams](#teams) on, each entry says who did it: a person ("Alice"), an API
token and the person it acts for ("via API token “Kuma” (Alice)"), or how a card came in ("submit page (Sam)", "card
import", "recurring"). Entries from before 1.5 show no name, because nobody was recorded then.

The **work log** is for your own notes: "Reseated the SATA cable", "Rolled back to 1.32.5". With Teams on, each entry
shows who wrote it. You can backdate an entry to when it actually happened, and edit or retract it later. The original
stays in the entry's history, which also says who made each edit, and the card's history says who retracted or restored
it. Only the person who wrote an entry, or an admin, can edit or retract it; entries from before 1.5 have no author, so
only admins can change those. Hover over a name to see the username, since two people can share a display name.

## Watching, mentions and the bell

*With [Teams](#teams) on; with it off, the bell only holds new submit-page tickets.* **Watch** a card to hear about it:
a new note, a move (including done or reopened), or a new assignee. The button is in the card's header (the eye on a
phone); press it again to stop. You watch a card automatically when you create it in the app, are assigned it, are
mentioned on it, or write a note on it.

**Mention** someone in a work-log note with `@` and their username: `Swapped the cable, @sam can you test it?`. Type
`@` and the first letters of a name or username, then pick from the list with the arrow keys and Enter (or tap a
name). Mentions of people on this install are highlighted, yours in a different colour. The person is told and
starts watching the card. Editing a note tells only the people it didn't mention before; a retracted note tells
nobody. `@` in code or an email address isn't a mention.

**The bell** in the top bar shows how many notifications you haven't read: cards assigned to you, mentions, changes on
cards you watch, and (for admins, by default) new tickets from the submit page. Open the list and pick one to go to its
card, or **Mark all read**. Opening a card, from the bell or anywhere else, marks its notifications read. You're never
told about your own changes. The bell checks for news every 30 seconds, also while the tab is in the background, and can
play a sound when something new comes in: **Off**, **Chime** or **Ping**, chosen per device under **Settings →
Appearance**, with a **Test** button. With several tabs open, only one plays it. Browsers only allow sound once you've
clicked or typed on the page.

Under **Account → Notifications** you choose what reaches you and where: in the app, as a Discord mention, or on
your own ntfy topic, and whether new tickets from the submit page, or from outside and with nobody on them, should
reach you too. See [NOTIFICATIONS.md](NOTIFICATIONS.md#personal-notifications) for setting up Discord and ntfy.

## Finding things

- **Search** (press `/`) looks through titles, descriptions, checklists, work logs and resolution notes, archived
  cards included.
- **Seen this before?** An open ticket lists up to five finished tickets that look like it, with how each ended:
  the resolution reason and the start of its note. A ticket with no note that was part of a work card points to the
  work card, where the fix may be written up. **Link** links one as related; it won't be suggested again. The section
  only shows up when there's a match. It compares titles and descriptions (not resolutions), archived tickets
  included. Two tickets need at least two distinctive words in common (one, if that's all the open ticket has), and
  at least one word from the open ticket's title. Common words, IP addresses, the submit page's standard wording and
  request type names don't count, and forms of a word ("update", "updated") count as one.
- **Calendar** shows what was due, what got done and what work was logged, by month or week.
- **Archive** and **Trash** are in the main menu. Archived cards are tucked away but searchable. Deleted cards go to
  Trash, where they can be restored; nothing is ever purged.

## Recurring maintenance

Under **Recurring**, set up cards that should appear on a schedule: a monthly parity check, a quarterly look at
SMART data. Each one creates a Triage card when it's due, and never makes a second one while the last is still open.

## Adding tickets

**Add ticket** in the top bar (or `Shift+N`) opens a form for a new ticket. A card typed straight into a column
(or with `n`) is quicker still: just a title, sorted out later.

Once the title has two words, up to three similar finished tickets show under it, so you can check an old fix before
filing the same problem again. They open in a new tab, so the ticket you're writing stays put.

With [Claude drafting](AI-DRAFTING.md) turned on, you can describe a problem in your own words instead and review the
ticket Claude writes. Without it, [Import from JSON](CARD-IMPORT.md) does something similar with any AI chat.

Tickets can also come from other people through the [submit page](SUBMIT-PAGE.md), and from monitoring tools through
[automation](AUTOMATION.md).

## People and your account

Since 1.5, more than one person can use Belltower, each with their own username and password. To give people cards
and let them follow each other's work, turn on [Teams](#teams); while it's off, Settings → People says so as soon as
there's more than one active person.

- **Admins** run the install: people, the install's settings, the submit page, notification channels and backups.
  They do the board work too.
- **Members** do the board work: cards, columns, labels, templates, card import and the work log. They manage their
  own account and API tokens.

The **owner** is the account the install was set up with (`admin` after an upgrade from 1.4). It's always an active
admin, and `APP_PASSWORD` can set its password, so there's always a way back in (see
[INSTALL.md](INSTALL.md#forgot-the-password)).

**Settings → People** (admins only):

- **Add person**: a username (what they sign in with), a display name (how others see them in history), a role, and
  a temporary password to hand over. **Generate** makes one up. They can change it under Account.
- **Edit** someone to change their display name or role, reset their password, or **Deactivate** them. Resetting a
  password or deactivating someone signs them out everywhere. A deactivated person can't sign in and their API tokens
  stop working, but they keep their name in the history. **Re-enable** brings them and their tokens back. Nobody is
  ever deleted.
- **Restrict to tags** (members only) limits someone to tickets that carry at least one of the tags you pick, say a
  family member who should only see Plex requests. With Teams on or off:
  - They see a ticket only if it has one of their tags. **Tickets without tags are hidden from them.** Everything else
    follows: the board, search, the calendar, Archive and Trash, linked and parent tickets (left out, or shown as
    "Hidden ticket" in history), the bell, their API tokens and the automation API.
  - If every one of their tags is deleted, they see nothing (never everything).
  - A ticket they create gets their tags if it has none of them. They can take their own tag off a ticket; it then
    leaves their view.
  - They can't add, rename or delete tags, change columns, set the blocked column, archive all of Done, sort a column,
    or manage recurring templates. The board hides those controls for them.
  - They're only told about tickets they can see, and a ticket can only be given to them if it carries one of their
    tags (an admin's assignee list leaves them out otherwise; for anyone else the app explains the refusal). Narrowing their tags, or taking their tag off a ticket they\n    have, unassigns them from tickets they can no longer see; each shows in the ticket's history.
  - Admins and the owner always see every ticket; making someone an admin lifts their restriction.
- What can't work isn't offered: the owner can't be demoted or deactivated, you can't deactivate yourself or reset
  your own password there (that's under Account), and the last active admin stays an admin.

**Menu → Account** (everyone): your display name and email, **Sign-in** (linking your account to
[single sign-on](SSO.md), when an admin has set it up), your password (changing it signs you out on your other
devices; the owner's can't be changed here while `APP_PASSWORD` sets it), **Notifications** (with Teams on: what
reaches you, and where; see [Watching, mentions and the bell](#watching-mentions-and-the-bell)), and **Your tokens**:
API tokens that act as you. What a token does shows in the history as "via API token" with your name, and it stops
working while your account is deactivated.

## Settings

**Menu → Settings** holds everything that isn't about one card. Members only see Appearance and the version;
the rest is for admins.

- **Appearance:** Light, Dark or System, and the bell's sound (off, chime or ping) wherever there's a bell. These are
  saved per device, so the phone can follow the system while the desktop stays dark, and the work laptop can stay quiet.
- **General:** [Teams](#teams), the ticket number format, the app's address (for links in notifications), the Claude
  model, and where blocked cards go.
- **Resolution reasons:** the list offered on Mark done. The first one is the default.
- **People:** see [People and your account](#people-and-your-account).
- **Submit page**, **Automation** tokens (everyone's, with whose each is) and
  **[Notifications](NOTIFICATIONS.md)** (Discord, ntfy, Gotify, webhook).
- **[Single sign-on](SSO.md):** signing in through Authentik, Authelia or another OIDC provider.
- The app's version. Your password and your own tokens are under **Account**.

## Keyboard shortcuts

| Key | |
|---|---|
| `n` | New card in Triage |
| `Shift+N` | Add ticket |
| `/` | Search |
| `Esc` | Close the top menu, dialog or card |
| `Space`, arrows, `Space` | Move the focused card |
| `Enter` | Accept the Mark done dialog |
| `Ctrl/⌘ + Enter` | Save the description or work-log note you're editing |

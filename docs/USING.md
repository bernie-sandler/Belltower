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

The filter bar narrows the board by text, label, priority, severity, due date or assignee.

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

## Who has what

A card can be **assigned** to one person: pick them under **Assignee** in the card, or press **Assign to me**. Their
initials show on the card's tile (hover for the full name). Deactivated people can't be given cards; one who still
has a card keeps it until someone changes it.

Two pages in the top bar sort out the work:

- **Mine** lists your open cards, most urgent first.
- **Unassigned** is the queue: every open card nobody has, from any column, most urgent first and then oldest.
  **Take it** gives the card to you. If someone else took it a moment before you, you're told who, and it stays
  theirs.

Both leave out finished cards (and, like the board, archived cards and the Trash). On the board, the filter's
**Assignee** group shows your cards, unassigned ones, or someone else's. It's kept in the address
(`?assignee=me`), so a bookmark works.

## History and the work log

Every change to a card is recorded automatically: moves, edits, labels, links, assignments, resolutions. The
history can't be edited or deleted, by design.

The **work log** is for your own notes: "Reseated the SATA cable", "Rolled back to 1.32.5". You can backdate an entry
to when it actually happened, and edit or retract it later. The original stays in the entry's history.

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

## Settings

**Menu → Settings** holds everything that isn't about one card:

- **Appearance:** Light, Dark or System. This is saved per device, so the phone can follow the system while the
  desktop stays dark.
- **General:** the ticket number format, the app's address (for links in notifications), the Claude model, and where
  blocked cards go.
- **Resolution reasons:** the list offered on Mark done. The first one is the default.
- **Submit page**, **Automation** tokens and **[Notifications](NOTIFICATIONS.md)** (Discord, ntfy, Gotify, webhook).
- **Password** and the app's version.

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

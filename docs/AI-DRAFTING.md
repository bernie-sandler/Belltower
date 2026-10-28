# Claude drafting (optional)

Writing a good ticket when something's on fire is a chore. With an Anthropic API key, you can describe the problem
the way you'd tell a friend, and Claude turns it into a proper ticket for you to check. It's entirely optional:
without a key, the app never talks to the internet.

## What you get

Press **Add ticket** (or `Shift+N`) and choose one of these:

**Describe the issue.** Write what's wrong: symptoms, error messages, what changed, what you already tried. In 10–30
seconds you get a ticket to review:

- a title, and a Markdown description split into Symptoms, Details and Next steps;
- a priority (from impact × urgency) and a severity, each with a one-line reason;
- labels picked from the ones you already have;
- a checklist of next steps;
- whether it's a ticket or a work card, an open work card it belongs under, and open cards it blocks, waits on or
  relates to, each with a reason.

Change anything you like (including removing a suggested link), then press **Create ticket**. Nothing is saved until
you do.

**Describe several issues.** Paste a messy list, notes from a weekend of tinkering, or a chunk of logs. Claude
splits it into one card per issue, groups steps of the same job under a work card, and links cards that depend on
each other. You get the same preview as a [card import](CARD-IMPORT.md), and **Create** makes them all at once.

If Claude can't be reached or the key is wrong, the dialog says so and lets you fill the ticket in by hand.

## Setting it up

1. Create an API key at [console.anthropic.com](https://console.anthropic.com). It needs a little prepaid credit.
2. Add it to `.env`: `ANTHROPIC_API_KEY='…'` (the single quotes matter if it contains a `$`).
3. Run `docker compose up -d`.

The container log should now say "Claude drafting on". The model can be changed under **Settings → General**.

## Cost

A single draft costs roughly 1–3 cents with the default model. "Describe several issues" counts as one draft but
uses more, depending on how much you paste. To keep a stuck page from running up a bill, the app allows 20 drafts per
10 minutes.

## Privacy

Only what Claude needs is sent to Anthropic, from your server:

- the text you type or paste;
- your label names and today's date;
- the ticket numbers and titles of your open cards (up to 100), so Claude can suggest a work card and links.

Descriptions, history, work logs and attachments of existing cards are never sent.

## No key? Use any AI chat instead

Without a key, **Add ticket** offers **Import from JSON**. Copy the ready-made prompt, give it to whatever AI you
like, and paste the answer back. You get the same preview before anything is created. See
[CARD-IMPORT.md](CARD-IMPORT.md).

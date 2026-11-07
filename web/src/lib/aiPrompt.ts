// The instructions to give an AI so its answer can be pasted straight into "Import cards".
// Built from the live board, so it lists your real column and label names.

import type { CardTile, Column, Label } from '@tt/shared';

export function buildAiPrompt(columns: Column[], labels: Label[], today: string, workCards: CardTile[] = []): string {
  const cols = columns.map((c) => c.name).join(', ');
  const labs = labels.map((l) => l.name).join(', ');
  const works = workCards.length
    ? workCards.map((w) => `  ${w.ticketNo ?? `#${w.id}`}: ${w.title}`).join('\n')
    : '  (none yet)';
  return `You are helping me file issues in my homelab issue tracker ("Belltower").
Turn what I describe below into one or more cards. Reply with ONLY a JSON code block in exactly this format:

\`\`\`json
{
  "format": "belltower/cards@1",
  "cards": [
    {
      "title": "Short, specific summary (max 300 characters)",
      "description": "Markdown. What's wrong, symptoms, error messages, what was already tried, likely causes.",
      "column": "Triage",
      "labels": ["Plex"],
      "priority": "P2",
      "severity": "S3",
      "due": "2026-10-30",
      "checklists": [
        { "title": "Diagnose", "items": ["First concrete step", "Second step"] }
      ],
      "worklog": [
        { "text": "Something I already did, in Markdown", "at": "2026-10-09 20:15" }
      ]
    }
  ]
}
\`\`\`

Rules:
- Only "title" is required. Leave out any field you don't know rather than guessing.
- "column" must be one of: ${cols}. Default to "Triage" for new problems.
- "labels": pick from my existing labels when they fit: ${labs}. You may add a new short label if none fits.
- "priority" from the matrix of impact × urgency:
  impact High: urgency High → P0, Medium → P1, Low → P2
  impact Medium: urgency High → P1, Medium → P2, Low → P3
  impact Low: urgency High → P2, Medium → P3, Low → P3
- "severity" (how bad the impact is): S1 Blocker = crash, data loss, or the system is unusable;
  S2 Major = a core function is broken; S3 Minor = partial breakage or an inconvenience;
  S4 Trivial = visual or text issues.
- "due" is optional: "YYYY-MM-DD" or "YYYY-MM-DD HH:MM" (24h). Today is ${today}.
- "checklists": concrete, checkable diagnostic or fix steps, in order.
- "worklog": only things I said I already did, with "at" as "YYYY-MM-DD HH:MM" if I gave a time.
- One card per distinct problem.
- Work cards group related tickets like a folder: a work card is what I'm actually working on, tickets are
  the individual issues or findings. For a bigger job with several parts, make one work card
  ("type": "work") and put its tickets in "tickets": [...] (one level only), for example:
  { "type": "work", "title": "Upgrade Plex", "tickets": [ { "title": "Back up the Plex database" }, { "title": "Test HDR playback" } ] }
- To file a ticket under one of my existing open work cards, add "partOf" with its ticket number:
${works}
  A ticket can also point at a work card in the same answer by giving that work card a "ref" (e.g. "ref": "plex")
  and using "partOf": "plex".
- Links between cards (optional): "blocks", "blockedBy" (this card can't be finished until those are done)
  and "relatedTo", each a list of other cards. Name a card in the same answer by its "ref" (any card can
  have one), or a card already on my board by its ticket number (like 261027-1). For example:
  { "ref": "swap", "title": "Swap UPS battery", "blockedBy": ["order-battery"], "relatedTo": ["261024-1"] }
  Give each link once; don't make two cards block each other.

Here's the problem:
`;
}

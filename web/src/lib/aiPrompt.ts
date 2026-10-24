// The instructions to give an AI so its answer can be pasted straight into "Import cards".
// Built from the live board, so it lists your real column and label names.

import type { Column, Label } from '@tt/shared';

export function buildAiPrompt(columns: Column[], labels: Label[], today: string): string {
  const cols = columns.map((c) => c.name).join(', ');
  const labs = labels.map((l) => l.name).join(', ');
  return `You are helping me file issues in my homelab issue tracker ("Tower Tracker").
Turn what I describe below into one or more cards. Reply with ONLY a JSON code block in exactly this format:

\`\`\`json
{
  "format": "tower-tracker/cards@1",
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

Here's the problem:
`;
}

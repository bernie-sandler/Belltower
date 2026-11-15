// Pulls the newest release out of CHANGELOG.md for the "What's new" dialog. Runs at build time
// (the `virtual:latest-changelog` module in vite.config.ts), so only that one section ships in
// the bundle and nothing is fetched at runtime.

export interface ChangelogSection {
  /** "1.6.0" */
  version: string;
  /** "Theme editor" */
  title: string;
  /** The section's Markdown, without its heading. */
  body: string;
}

/** Where relative links in the changelog (docs/UPGRADING.md…) point once they're shown in the app. */
export const REPO_BLOB = 'https://github.com/bernie-sandler/belltower/blob/main/';

/** The first `## <version>: <title>` section, or null when there is none. */
export function latestChangelogSection(markdown: string): ChangelogSection | null {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^## \S/.test(l));
  if (start < 0) return null;
  const heading = /^## +([^\s:]+)(?::\s*(.*))?$/.exec(lines[start]!.trim());
  if (!heading) return null;
  let end = lines.findIndex((l, i) => i > start && /^## \S/.test(l));
  if (end < 0) end = lines.length;
  const body = lines
    .slice(start + 1, end)
    .join('\n')
    .trim()
    // Relative links only work on GitHub: point them there.
    .replace(/\]\((?![a-z][a-z0-9+.-]*:|#|\/)([^)\s]+)\)/gi, (_m, path: string) => `](${REPO_BLOB}${path})`);
  return { version: heading[1]!, title: (heading[2] ?? '').trim(), body };
}

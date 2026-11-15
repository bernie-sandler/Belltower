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
  const body = unwrap(lines.slice(start + 1, end))
    .trim()
    // Relative links only work on GitHub: point them there.
    .replace(/\]\((?![a-z][a-z0-9+.-]*:|#|\/)([^)\s]+)\)/gi, (_m, path: string) => `](${REPO_BLOB}${path})`);
  return { version: heading[1]!, title: (heading[2] ?? '').trim(), body };
}

/** Starts its own line: a list item, heading, quote, table row or code fence. */
const BLOCK_START = /^\s*(?:[-*+] |\d+\. |#|>|\||```)/;

/**
 * The changelog is hard-wrapped, and the app's Markdown turns every newline into a line break: join
 * each wrapped line onto the one before, except after a blank line, before a line that starts a
 * block, after a heading or table row, and inside code fences.
 */
function unwrap(lines: string[]): string {
  const out: string[] = [];
  let fenced = false;
  for (const line of lines) {
    const prev = out.at(-1);
    const fence = line.trimStart().startsWith('```');
    const join =
      !fenced && !fence && prev !== undefined && prev.trim() !== '' && line.trim() !== '' && !BLOCK_START.test(line) && !/^\s*(?:#|\||```)/.test(prev);
    if (join) out[out.length - 1] = `${prev.trimEnd()} ${line.trim()}`;
    else out.push(line);
    if (fence) fenced = !fenced;
  }
  return out.join('\n');
}

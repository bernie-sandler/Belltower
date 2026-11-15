import { describe, expect, it } from 'vitest';
import { latestChangelogSection, REPO_BLOB } from './changelogSection';

const SAMPLE = `# Changelog

Intro with a [link](docs/UPGRADING.md#what-10-promises).

## 1.6.0: Theme editor

- **Themes.** Pick colors. See [docs](docs/THEMES.md) or [the site](https://example.com) or [above](#top).

## 1.5.1: Buttons that stay put

- Old stuff.
`;

describe('latestChangelogSection', () => {
  it('returns only the newest section, with its version and title', () => {
    const s = latestChangelogSection(SAMPLE)!;
    expect(s.version).toBe('1.6.0');
    expect(s.title).toBe('Theme editor');
    expect(s.body).toContain('**Themes.**');
    expect(s.body).not.toContain('Old stuff');
    expect(s.body).not.toContain('Intro');
  });

  it('points relative links at the repository and leaves the others alone', () => {
    const s = latestChangelogSection(SAMPLE)!;
    expect(s.body).toContain(`[docs](${REPO_BLOB}docs/THEMES.md)`);
    expect(s.body).toContain('[the site](https://example.com)');
    expect(s.body).toContain('[above](#top)');
  });

  it('handles Windows line endings, rc versions and a missing title', () => {
    const s = latestChangelogSection('# C\r\n\r\n## 2.0.0-rc.1\r\n\r\n- One\r\n')!;
    expect(s).toEqual({ version: '2.0.0-rc.1', title: '', body: '- One' });
  });

  it('returns null without a release section', () => {
    expect(latestChangelogSection('# Changelog\n\nNothing yet.')).toBeNull();
  });
});

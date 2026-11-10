// @mentions in rendered notes: known people are highlighted (you differently), with the same
// rules as the server's findMentions, and the output stays safe.

import { describe, expect, it } from 'vitest';
import { renderMarkdown, type MentionPeople } from './markdown';

const people: MentionPeople = new Map([
  ['sam', { displayName: 'Sam Rivera', me: false }],
  ['sam.smith', { displayName: 'Sam Smith', me: false }],
  ['me', { displayName: 'Me <b>"x"</b>', me: true }],
]);
const html = (md: string) => renderMarkdown(md, { people });
const mentions = (md: string) => [...html(md).matchAll(/<span class="mention[^"]*"[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]);

describe('mention highlighting', () => {
  it('highlights known people, keeping how they were typed', () => {
    expect(html('thanks @Sam!')).toBe('<p>thanks <span class="mention" title="Sam Rivera">@Sam</span>!</p>\n');
    expect(mentions('@sam.smith and @sam.')).toEqual(['@sam.smith', '@sam']);
    expect(html('(@sam)')).toContain('(<span class="mention"');
  });

  it('marks you, and escapes names in the title', () => {
    expect(html('@me')).toBe('<p><span class="mention is-me" title="Me &lt;b&gt;&quot;x&quot;&lt;/b&gt;">@me</span></p>\n');
  });

  it('leaves unknown names, emails, URLs, escapes and code alone', () => {
    expect(mentions('@nobody here')).toEqual([]);
    expect(mentions('mail sam@example.com')).toEqual([]);
    expect(html('mail sam@example.com')).toContain('<a href="mailto:sam@example.com"');
    expect(mentions('see https://mastodon.social/@sam')).toEqual([]);
    expect(mentions('literally \\@sam')).toEqual([]);
    expect(mentions('run `ping @sam` now')).toEqual([]);
    expect(mentions('```\n@sam\n```')).toEqual([]);
    expect(mentions('@sam@elsewhere.social')).toEqual([]);
  });

  it('works inside emphasis and links, and not at all without people', () => {
    expect(mentions('**ask @sam**')).toEqual(['@sam']);
    expect(renderMarkdown('thanks @sam')).toBe('<p>thanks @sam</p>\n');
  });

  it('can’t be used to inject markup', () => {
    const out = html('@sam<img src=x onerror=alert(1)> <script>@sam</script>');
    expect(out).not.toMatch(/<img|<script/);
    expect(mentions('@sam<img src=x>')).toEqual(['@sam']);
  });
});

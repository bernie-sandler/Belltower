// @mentions in rendered notes: known people are highlighted (you differently), with the same
// rules as the server's findMentions, and the output stays safe.

import { findMentions } from '@tt/shared';
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

  it('highlights exactly the people the server notifies', () => {
    const known = new Set(people.keys());
    for (const md of [
      'thanks @Sam and @me.',
      'mail sam@example.com, see https://x.social/@sam, \\@sam',
      'run `ping @sam` then ``a `b` @me`` and @sam.smith',
      'before @sam\n```\n@me\n```\nafter',
      'before @sam\n\n    chown @me file\n\nafter @sam.smith',
      'text\n    cc @me',
      '- item\n\n    more for @me',
      '@sam@elsewhere.social and (@me)',
    ]) {
      const highlighted = [...new Set(mentions(md).map((m) => m!.slice(1).toLowerCase()))];
      expect(highlighted, md).toEqual(findMentions(md, known));
    }
  });

  it('can’t be used to inject markup', () => {
    const out = html('@sam<img src=x onerror=alert(1)> <script>@sam</script>');
    expect(out).not.toMatch(/<img|<script/);
    expect(mentions('@sam<img src=x>')).toEqual(['@sam']);
  });
});

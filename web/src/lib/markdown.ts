// Markdown → HTML for descriptions and work-log entries. This is the only place the app produces
// HTML from user text: raw HTML is off (escaped, not rendered), markdown-it refuses javascript:,
// vbscript: and data:text links, and the page CSP blocks scripts and remote images regardless.
//
// Work-log notes also highlight @mentions of known people (the `people` option). The mention is
// its own token, rendered here with escaped text, so it adds no way to inject markup; code spans,
// fenced code and email addresses are never mentions (the same rules as findMentions, which
// decides who is notified).

import { resolveMention } from '@tt/shared';
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });

// Absolute links open in a new tab so the installed (Home Screen) app isn't navigated away.
const defaultLinkOpen =
  md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]!;
  const href = String(token.attrGet('href') ?? '');
  if (/^https?:\/\//i.test(href)) {
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noopener noreferrer');
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

// Images load lazily and never wider than their container (CSS).
const defaultImage = md.renderer.rules.image!;
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  tokens[idx]!.attrSet('loading', 'lazy');
  tokens[idx]!.attrSet('decoding', 'async');
  return defaultImage(tokens, idx, options, env, self);
};

/** People who can be @mentioned, by lower-case username. */
export type MentionPeople = ReadonlyMap<string, { displayName: string; me: boolean }>;

type Env = {
  people?: MentionPeople;
  known?: ReadonlySet<string>;
};

/** The character before an @ that makes it part of something else (an email, a URL, \@ or @@). */
const NOT_BEFORE_MENTION = /[\p{L}\p{N}._+\-/@\\]/u;
const MENTION_AT = /^@([A-Za-z0-9._-]{2,32})(?![A-Za-z0-9._@-])/;

/** @username of someone in env.people, as a `mention` token. Inline rules never run inside code. */
const mentionRule: Parameters<typeof md.inline.ruler.after>[2] = (state, silent) => {
  const env = state.env as Env;
  if (!env.people || state.src.charCodeAt(state.pos) !== 0x40 /* @ */) return false;
  const before = state.pos > 0 ? state.src[state.pos - 1]! : '';
  if (before && NOT_BEFORE_MENTION.test(before)) return false;
  const m = MENTION_AT.exec(state.src.slice(state.pos, state.pos + 40));
  if (!m) return false;
  env.known ??= new Set(env.people.keys());
  const name = resolveMention(m[1]!, env.known);
  if (!name) return false;
  // "@sam." matched as "sam": the dot stays ordinary text.
  const length = 1 + name.length;
  if (!silent) {
    const token = state.push('mention', '', 0);
    token.content = state.src.slice(state.pos, state.pos + length);
    token.meta = { username: name };
  }
  state.pos += length;
  return true;
};

md.inline.ruler.after('text', 'mention', mentionRule);
md.renderer.rules.mention = (tokens, idx, _options, env) => {
  const token = tokens[idx]!;
  const person = (env as Env).people?.get((token.meta as { username: string }).username);
  const esc = md.utils.escapeHtml;
  const title = person ? ` title="${esc(person.displayName)}"` : '';
  return `<span class="mention${person?.me ? ' is-me' : ''}"${title}>${esc(token.content)}</span>`;
};

/** `people`: highlight @mentions of these (work-log notes, where mentions notify). */
export function renderMarkdown(text: string, opts: { people?: MentionPeople } = {}): string {
  const env: Env = { people: opts.people };
  return md.render(text, env);
}

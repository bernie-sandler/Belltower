// Markdown → HTML for descriptions and work-log entries. This is the only place the app produces
// HTML from user text: raw HTML is off (escaped, not rendered), markdown-it refuses javascript:,
// vbscript: and data:text links, and the page CSP blocks scripts and remote images regardless.

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

export function renderMarkdown(text: string): string {
  return md.render(text);
}

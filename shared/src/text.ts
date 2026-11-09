// Text helpers shared by the server and the browser-only demo, so "Seen this before?" picks the
// same words and counts matches the same way in both.

/**
 * Folds case and strips diacritics from Latin letters, like SQLite FTS5's unicode61 tokenizer
 * (remove_diacritics 2). Other scripts keep theirs (Greek tonos, Cyrillic й), as in the index.
 */
export const foldText = (s: string): string =>
  s.normalize('NFD').replace(/(\p{Script=Latin})\p{M}+/gu, '$1').normalize('NFC').toLowerCase();

export interface TextToken {
  /** Folded. */
  text: string;
  start: number;
  end: number;
}

/** Words as FTS5's unicode61 tokenizer sees them: runs of letters and digits ("nginx.conf" → nginx, conf). */
export function tokenizeText(text: string): TextToken[] {
  return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({ text: foldText(m[0]), start: m.index, end: m.index + m[0].length }));
}

/**
 * A submitted ticket's description without the submit page's scaffolding: the "### Plex details"
 * heading, the question labels ("- **Device or app:** Roku" keeps "Roku") and the "Submitted
 * through the submit page" footer. Every submitted ticket shares those words, so they'd make
 * unrelated tickets look alike.
 */
export function stripSubmitScaffolding(md: string): string {
  return md
    .replace(/(?:^|\n)-{3,}\n_Submitted[^\n]*_\s*$/, '')
    .replace(/^#{1,6} .* details$/gm, '')
    .replace(/^- \*\*[^*\n]+\*\* ?/gm, '')
    .replace(/^\*\*[^*\n]+\*\*$/gm, '');
}

/** Markdown → a short line of plain text (for previews where cut-off Markdown would break). */
export function plainTextPreview(md: string, max: number): string {
  // Only the start is shown, so only the start is cleaned (which also keeps the patterns below cheap).
  const text = md
    .slice(0, max * 4)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Words too common to say two tickets are about the same thing. */
const STOP_WORDS = new Set(
  `about after again all also and any are because been before being but can cannot could did does doesn don done down
   each even ever every few for from get gets getting got had has have having her here him his how into isn its just
   keep keeps know last let like make many may maybe might more most much need needs not now off once only other
   our out over please really said same see seems should since some something still such than that the their them
   then there these they thing things this those though through too try tried trying under until very was wasn way
   were what when where which while who why will with won work works working would yes yet you your`.split(/\s+/),
);

/**
 * A rough English stem, so "failed", "failing" and "fails" all become "fail" (matched as a prefix,
 * that also finds "failure"). Only trims when at least 4 characters are left, and leaves words
 * where the ending is part of the word ("exceed", "supply", "family").
 */
export function stemWord(w: string): string {
  if (w.length <= 4 || /^\d+$/.test(w)) return w;
  for (const suffix of ['ing', 'ed', 'ly', 'es']) {
    if (!w.endsWith(suffix) || w.length - suffix.length < 4) continue;
    if ((suffix === 'ed' && w.endsWith('eed')) || (suffix === 'ly' && /(?:p|i|al)ly$/.test(w))) continue;
    return w.slice(0, -suffix.length);
  }
  if (w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  // "change" → "chang", like "changing" and "changed".
  if (w.endsWith('e') && !w.endsWith('ee')) return w.slice(0, -1);
  return w;
}

/**
 * Whether two terms stand for the same word: equal, or one starts with the other when the shorter
 * has 4 or more characters ("update" and "updat", from "updates").
 */
export function sameTerm(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short);
}

/** IPv4 addresses: their parts ("192", "168") would count as words every LAN ticket shares. */
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;

/**
 * The distinctive words of a ticket's text, in order, for finding similar ones: folded and
 * stemmed, at least 3 characters, no common words, IP addresses or long digit runs (ticket
 * numbers, dates). Forms of one word count once, as the shortest. At most `max`.
 */
export function similarityTerms(text: string, max = 12): string[] {
  const out: string[] = [];
  for (const { text: w } of tokenizeText(text.replace(IPV4, ' '))) {
    if (w.length < 3 || STOP_WORDS.has(w) || /^\d{5,}$/.test(w)) continue;
    const stem = stemWord(w);
    const same = out.findIndex((t) => sameTerm(t, stem));
    if (same >= 0) {
      if (stem.length < out[same]!.length) out[same] = stem;
      continue;
    }
    out.push(stem);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * A submitted ticket's title without its request type's name in front ("Plex – Interstellar –
 * stutters" → "Interstellar – stutters"): every ticket of that type starts the same way.
 */
export function stripTypePrefix(title: string, typeNames: readonly string[]): string {
  const lower = title.toLowerCase();
  for (const name of typeNames) {
    const prefix = name.trim().toLowerCase();
    if (!prefix || !lower.startsWith(prefix)) continue;
    const m = /^\s+[–—-]\s+/u.exec(title.slice(prefix.length));
    if (m) return title.slice(prefix.length + m[0].length);
  }
  return title;
}

/** Whether `term` matches a word: exactly, or as a prefix when it has 4 or more characters (as the FTS query does). */
export const termMatchesWord = (term: string, word: string): boolean => word === term || (term.length >= 4 && word.startsWith(term));

/** The `terms` that appear somewhere in `text`. */
export function matchedTerms(terms: readonly string[], text: string): string[] {
  const words = [...new Set(tokenizeText(text).map((t) => t.text))];
  return terms.filter((term) => words.some((w) => termMatchesWord(term, w)));
}

/**
 * Whether a finished ticket is close enough to show under "Seen this before?": at least two of the
 * distinctive `terms` in common (one, when there's only one), and at least one word of the new
 * ticket's title, since the title is what it's about and descriptions wander. `titleTerms` are
 * the title's words before common ones were dropped, so a title of only common words still has
 * to match; it's empty only when the title has no words worth comparing.
 */
export function similarEnough(terms: readonly string[], titleTerms: readonly string[], candidateText: string): boolean {
  if (matchedTerms(terms, candidateText).length < Math.min(2, terms.length)) return false;
  return !titleTerms.length || matchedTerms(titleTerms, candidateText).length > 0;
}

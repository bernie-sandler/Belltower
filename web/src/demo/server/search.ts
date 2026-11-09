// Mirrors server/src/services/search.ts. The server uses SQLite FTS5; the demo has no database, so
// it searches the same five fields itself: every word is a prefix match, all words must match
// somewhere on the card, and snippets mark hits with \u0002 … \u0003 the way FTS5's snippet() does.

import {
  plainTextPreview,
  similarEnough,
  similarityTerms,
  stripSubmitScaffolding,
  stripTypePrefix,
  termMatchesWord,
  tokenizeText,
  type SearchField,
  type SearchQuery,
  type SearchResult,
  type SimilarTicket,
  type TextToken,
} from '@tt/shared';
import { columnName } from './cardParts';
import type { CardRow, Ctx } from './db';
import { labelIdsOf } from './labels';
import { addDays, startOfLocalDay } from './lib';

const FIELDS: SearchField[] = ['title', 'description', 'checklists', 'worklogs', 'history'];
/** bm25 weights the server gives each field. */
const WEIGHTS = [10, 4, 2, 3, 1];
const SNIPPET_TOKENS = 16;

/** FTS5's unicode61 tokenizer: folded runs of letters and digits (shared with the server's helpers). */
type Token = TextToken;
const tokenize = tokenizeText;

/** Each query word becomes a phrase of tokens whose last token is a prefix ("nginx.conf"*). */
export function queryTerms(text: string): string[][] {
  return text
    .split(/\s+/)
    .filter((t) => /[\p{L}\p{N}]/u.test(t))
    .map((t) => tokenize(t).map((x) => x.text))
    .filter((t) => t.length > 0);
}

/** Start indexes of every place `term` matches in `tokens`. */
function matchesAt(tokens: Token[], term: string[]): number[] {
  const out: number[] = [];
  for (let p = 0; p + term.length <= tokens.length; p++) {
    let ok = true;
    for (let k = 0; k < term.length && ok; k++) {
      const t = tokens[p + k]!.text;
      ok = k === term.length - 1 ? t.startsWith(term[k]!) : t === term[k];
    }
    if (ok) out.push(p);
  }
  return out;
}

function snippet(text: string, tokens: Token[], hits: Set<number>): string {
  const first = Math.min(...hits);
  const start = Math.max(0, Math.min(first - 2, tokens.length - SNIPPET_TOKENS));
  const end = Math.min(tokens.length, start + SNIPPET_TOKENS);
  let out = start > 0 ? '…' : '';
  let at = tokens[start]!.start;
  for (let i = start; i < end; i++) {
    const t = tokens[i]!;
    out += text.slice(at, t.start);
    out += hits.has(i) ? `\u0002${text.slice(t.start, t.end)}\u0003` : text.slice(t.start, t.end);
    at = t.end;
  }
  return end < tokens.length ? `${out}…` : out;
}

/** The five indexed fields of a card, built like reindexCard() builds the FTS row. */
export function searchFields(ctx: Ctx, card: CardRow): string[] {
  const lists = ctx.s.checklists.filter((l) => l.cardId === card.id).sort((a, b) => a.position - b.position);
  const checklistText: string[] = [];
  for (const l of lists) {
    checklistText.push(l.title);
    for (const i of ctx.s.checklistItems.filter((x) => x.checklistId === l.id).sort((a, b) => a.position - b.position)) {
      checklistText.push(i.text);
    }
  }
  const activity = ctx.s.activity.filter((a) => a.cardId === card.id);
  const worklogs = activity
    .filter((a) => a.kind === 'worklog' && !a.retractedAt)
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
    .map((a) => a.bodyMd ?? '');
  const history: string[] = card.ticketNo ? [card.ticketNo] : [];
  for (const e of [...activity].sort((a, b) => a.id - b.id)) {
    if (e.type === 'title_changed' && typeof e.data.from === 'string') history.push(e.data.from);
    if (e.type === 'attachment_added' && typeof e.data.name === 'string') history.push(e.data.name);
    if (e.type === 'linked' && typeof e.data.otherTitle === 'string') history.push(e.data.otherTitle);
  }
  const description =
    card.resolution || card.resolutionMd
      ? `${card.descriptionMd}\n\nResolution: ${card.resolution ?? ''}\n${card.resolutionMd}`
      : card.descriptionMd;
  return [card.title, description, checklistText.join('\n'), worklogs.join('\n\n'), [...new Set(history)].join('\n')];
}

export function searchCards(ctx: Ctx, q: SearchQuery): SearchResult[] {
  const terms = queryTerms(q.q);
  const filters: ((c: CardRow) => boolean)[] = [(c) => !c.deletedAt];
  if (q.status === 'board') filters.push((c) => !c.archivedAt);
  if (q.status === 'archived') filters.push((c) => c.archivedAt !== null);
  if (q.labelIds.length) filters.push((c) => c.labelIds.some((l) => q.labelIds.includes(l)));
  if (q.columnIds.length) filters.push((c) => q.columnIds.includes(c.columnId));
  for (const [key, values] of [
    ['priority', q.priorities],
    ['severity', q.severities],
  ] as const) {
    if (!values.length) continue;
    filters.push((c) => (c[key] === null ? values.includes('none') : values.includes(c[key])));
  }
  if (q.from || q.to) {
    const from = q.from ? startOfLocalDay(q.from, ctx.tz) : '0000';
    const to = q.to ? startOfLocalDay(addDays(q.to, 1), ctx.tz) : '9999';
    filters.push((c) => ctx.s.activity.some((a) => a.cardId === c.id && !a.retractedAt && a.occurredAt >= from && a.occurredAt < to));
  }
  // Filters only (no text) need at least one real filter, like the server.
  if (!terms.length && filters.length === 1) return [];

  const scored: { card: CardRow; score: number; matches: SearchResult['matches'] }[] = [];
  for (const card of ctx.s.cards) {
    if (!filters.every((f) => f(card))) continue;
    if (!terms.length) {
      scored.push({ card, score: 0, matches: [] });
      continue;
    }
    const fields = searchFields(ctx, card);
    const tokens = fields.map(tokenize);
    const hitsPerField = tokens.map(() => new Set<number>());
    let score = 0;
    let all = true;
    for (const term of terms) {
      let found = false;
      tokens.forEach((toks, i) => {
        for (const p of matchesAt(toks, term)) {
          found = true;
          score += WEIGHTS[i]!;
          for (let k = 0; k < term.length; k++) hitsPerField[i]!.add(p + k);
        }
      });
      if (!found) all = false;
    }
    if (!all) continue;
    const matches = FIELDS.flatMap((field, i) =>
      hitsPerField[i]!.size ? [{ field, snippet: snippet(fields[i]!, tokens[i]!, hitsPerField[i]!) }] : [],
    );
    scored.push({ card, score, matches });
  }

  return scored
    .sort((a, b) => b.score - a.score || b.card.updatedAt.localeCompare(a.card.updatedAt))
    .slice(0, q.limit)
    .map(({ card: c, matches }) => ({
      id: c.id,
      ticketNo: c.ticketNo,
      kind: c.kind,
      title: c.title,
      columnId: c.columnId,
      columnName: columnName(ctx, c.columnId),
      labelIds: labelIdsOf(ctx, c.labelIds),
      priority: c.priority,
      severity: c.severity,
      completedAt: c.completedAt,
      archivedAt: c.archivedAt,
      updatedAt: c.updatedAt,
      matches,
    }));
}

// ---------------------------------------------------------------------------------------------
// "Seen this before?" (mirrors similarCards in server/src/services/search.ts)
// ---------------------------------------------------------------------------------------------

const SIMILAR_CANDIDATES = 20;
const COMMON_SHARE = 0.15;
const COMMON_MIN_CARDS = 20;
const NOTE_PREVIEW = 300;
const QUERY_TEXT = 500;
const QUERY_SCAN = 4000;
const CANDIDATE_SCAN = 20_000;

/** Like the server's fts5vocab lookup: how many cards each word is on, over all five fields. */
function wordDocCounts(ctx: Ctx, live: CardRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const card of live) {
    const words = new Set(searchFields(ctx, card).flatMap((f) => tokenize(f).map((t) => t.text)));
    for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return counts;
}

export function similarCards(
  ctx: Ctx,
  input: { title: string; description: string; excludeId?: number; limit?: number },
): SimilarTicket[] {
  const typeNames = ctx.s.requestTypes.map((t) => t.name);
  const title = stripTypePrefix(input.title, typeNames);
  const picked = similarityTerms(`${title}\n${stripSubmitScaffolding(input.description.slice(0, QUERY_SCAN)).slice(0, QUERY_TEXT)}`);
  const titleTerms = similarityTerms(title);
  const live = ctx.s.cards.filter((c) => !c.deletedAt);
  let terms = picked;
  if (live.length >= COMMON_MIN_CARDS && picked.length) {
    const counts = wordDocCounts(ctx, live);
    const docs = (t: string) =>
      t.length >= 4 ? Math.max(0, ...[...counts].filter(([w]) => w.startsWith(t)).map(([, n]) => n)) : (counts.get(t) ?? 0);
    terms = picked.filter((t) => docs(t) / live.length <= COMMON_SHARE);
  }
  if (!terms.length) return [];

  const self = input.excludeId ?? 0;
  const linked = new Set(
    ctx.s.links.flatMap((l) => (l.fromCardId === self ? [l.toCardId] : l.toCardId === self ? [l.fromCardId] : [])),
  );
  const candidates: { card: CardRow; score: number }[] = [];
  for (const card of live) {
    if (!card.completedAt || card.kind !== 'ticket' || card.id === self || linked.has(card.id)) continue;
    // Title and description only, title weighted most, like the server's column filter and bm25.
    const [title, description] = searchFields(ctx, card).map((f) => tokenize(f).map((t) => t.text));
    let score = 0;
    for (const term of terms) {
      score += 10 * title!.filter((w) => termMatchesWord(term, w)).length;
      score += 4 * description!.filter((w) => termMatchesWord(term, w)).length;
    }
    if (score > 0) candidates.push({ card, score });
  }

  return candidates
    .sort((a, b) => b.score - a.score || b.card.completedAt!.localeCompare(a.card.completedAt!))
    .slice(0, SIMILAR_CANDIDATES)
    .map((c) => c.card)
    .filter((c) => {
      // Title and description only: resolution reasons and notes aren't what a ticket is about.
      const words = `${stripTypePrefix(c.title, typeNames)}\n${stripSubmitScaffolding(c.descriptionMd.slice(0, CANDIDATE_SCAN))}`;
      return similarEnough(terms, titleTerms, words);
    })
    .slice(0, input.limit ?? 5)
    .map((c) => {
      const parent = c.parentId !== null ? ctx.s.cards.find((p) => p.id === c.parentId && !p.deletedAt) : undefined;
      return {
        id: c.id,
        ticketNo: c.ticketNo,
        title: c.title,
        completedAt: c.completedAt!,
        archived: c.archivedAt !== null,
        resolution: c.resolution,
        note: plainTextPreview(c.resolutionMd, NOTE_PREVIEW),
        parent: parent ? { id: parent.id, ticketNo: parent.ticketNo, title: parent.title } : null,
      };
    });
}

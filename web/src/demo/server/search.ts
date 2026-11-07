// Mirrors server/src/services/search.ts. The server uses SQLite FTS5; the demo has no database, so
// it searches the same five fields itself: every word is a prefix match, all words must match
// somewhere on the card, and snippets mark hits with \u0002 … \u0003 the way FTS5's snippet() does.

import type { SearchField, SearchQuery, SearchResult } from '@tt/shared';
import { columnName } from './cardParts';
import type { CardRow, Ctx } from './db';
import { labelIdsOf } from './labels';
import { addDays, startOfLocalDay } from './lib';

const FIELDS: SearchField[] = ['title', 'description', 'checklists', 'worklogs', 'history'];
/** bm25 weights the server gives each field. */
const WEIGHTS = [10, 4, 2, 3, 1];
const SNIPPET_TOKENS = 16;

/** FTS5's unicode61 tokenizer folds case and strips diacritics. */
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

interface Token {
  text: string;
  start: number;
  end: number;
}

function tokenize(text: string): Token[] {
  return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({ text: fold(m[0]), start: m.index, end: m.index + m[0].length }));
}

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

import {
  plainTextPreview,
  similarEnough,
  similarityTerms,
  stripSubmitScaffolding,
  stripTypePrefix,
  type SearchField,
  type SearchQuery,
  type SearchResult,
  type SimilarTicket,
} from '@tt/shared';
import { stmt } from '../db/connection';
import { addDays } from '../lib/localdate';
import { startOfLocalDay } from '../lib/tz';
import type { Ctx } from './context';

/**
 * Rebuilds a card's single row in the FTS index (rowid = card id). One row per card means a
 * multi-word query matches even when the words sit in different parts of the card (title vs. a
 * work log). Deleted cards are removed from the index; archived cards stay searchable.
 * Called by every service that changes indexed text, inside the same transaction.
 */
export function reindexCard(ctx: Ctx, cardId: number): void {
  const db = ctx.db;
  stmt(db, 'DELETE FROM card_search WHERE rowid = ?').run(cardId);
  const card = stmt(db, 'SELECT id, ticket_no, title, description_md, resolution, resolution_md, deleted_at FROM cards WHERE id = ?').get(
    cardId,
  ) as
    | {
        id: number;
        ticket_no: string | null;
        title: string;
        description_md: string;
        resolution: string | null;
        resolution_md: string;
        deleted_at: string | null;
      }
    | undefined;
  if (!card || card.deleted_at) return;

  const checklistRows = stmt(
    db,
    `SELECT cl.title AS list_title, i.text AS item_text
       FROM checklists cl LEFT JOIN checklist_items i ON i.checklist_id = cl.id
      WHERE cl.card_id = ? ORDER BY cl.position, i.position`,
  ).all(cardId) as { list_title: string; item_text: string | null }[];
  const checklistText: string[] = [];
  let lastTitle: string | null = null;
  for (const r of checklistRows) {
    if (r.list_title !== lastTitle) {
      checklistText.push(r.list_title);
      lastTitle = r.list_title;
    }
    if (r.item_text) checklistText.push(r.item_text);
  }

  const worklogs = (
    stmt(
      db,
      `SELECT body_md FROM activity
        WHERE card_id = ? AND kind = 'worklog' AND retracted_at IS NULL ORDER BY occurred_at`,
    ).all(cardId) as { body_md: string }[]
  ).map((r) => r.body_md);

  // Extra searchable history: the ticket number, previous titles, attachment filenames, linked card titles.
  const history: string[] = card.ticket_no ? [card.ticket_no] : [];
  const events = stmt(
    db,
    `SELECT type, data FROM activity
      WHERE card_id = ? AND type IN ('title_changed', 'attachment_added', 'linked') ORDER BY id`,
  ).all(cardId) as { type: string; data: string }[];
  for (const e of events) {
    const d = JSON.parse(e.data) as Record<string, unknown>;
    if (e.type === 'title_changed' && typeof d.from === 'string') history.push(d.from);
    if (e.type === 'attachment_added' && typeof d.name === 'string') history.push(d.name);
    if (e.type === 'linked' && typeof d.otherTitle === 'string') history.push(d.otherTitle);
  }

  stmt(
    db,
    'INSERT INTO card_search (rowid, title, description, checklists, worklogs, history) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(cardId, card.title, withResolution(card), checklistText.join('\n'), worklogs.join('\n\n'), [...new Set(history)].join('\n'));
}

/** The description as indexed: plus the resolution, so "how did I fix this?" searches find it. */
function withResolution(card: { description_md: string; resolution: string | null; resolution_md: string }): string {
  if (!card.resolution && !card.resolution_md) return card.description_md;
  return `${card.description_md}\n\nResolution: ${card.resolution ?? ''}\n${card.resolution_md}`;
}

/** Rebuilds the whole index (after a restore, a migration, or if the startup check finds drift). */
export function rebuildSearch(ctx: Ctx): number {
  return ctx.db.transaction(() => {
    ctx.db.exec('DELETE FROM card_search');
    const ids = stmt(ctx.db, 'SELECT id FROM cards WHERE deleted_at IS NULL').pluck().all() as number[];
    for (const id of ids) reindexCard(ctx, id);
    return ids.length;
  })();
}

/** True when the index row count matches the number of searchable cards. */
export function searchIndexLooksConsistent(ctx: Ctx): boolean {
  const indexed = stmt(ctx.db, 'SELECT count(*) FROM card_search').pluck().get() as number;
  const live = stmt(ctx.db, 'SELECT count(*) FROM cards WHERE deleted_at IS NULL').pluck().get() as number;
  return indexed === live;
}

// ---------------------------------------------------------------------------------------------
// Querying
// ---------------------------------------------------------------------------------------------

const FIELDS: SearchField[] = ['title', 'description', 'checklists', 'worklogs', 'history'];

/**
 * User text → FTS5 query. Every word becomes a quoted prefix term ("nginx.conf"*, "10.0.0.5"*),
 * so punctuation in technical tokens can't break the syntax; words without letters or digits are
 * dropped; terms are ANDed (and since a card is one row, they may sit in different fields).
 */
export function toFtsQuery(text: string): string | null {
  const terms = text
    .split(/\s+/)
    .filter((t) => /[\p{L}\p{N}]/u.test(t))
    .map((t) => `"${t.replace(/"/g, '""')}"*`);
  return terms.length ? terms.join(' AND ') : null;
}

interface SearchRow {
  id: number;
  ticket_no: string | null;
  kind: SearchResult['kind'];
  title: string;
  column_id: number;
  column_name: string;
  label_ids: string | null;
  priority: SearchResult['priority'];
  severity: SearchResult['severity'];
  completed_at: string | null;
  archived_at: string | null;
  updated_at: string;
  s0?: string;
  s1?: string;
  s2?: string;
  s3?: string;
  s4?: string;
}

export function searchCards(ctx: Ctx, q: SearchQuery): SearchResult[] {
  const fts = toFtsQuery(q.q);
  const where: string[] = ['c.deleted_at IS NULL'];
  const params: unknown[] = [];

  if (q.status === 'board') where.push('c.archived_at IS NULL');
  if (q.status === 'archived') where.push('c.archived_at IS NOT NULL');
  if (q.labelIds.length) {
    where.push(`EXISTS (SELECT 1 FROM card_labels cl WHERE cl.card_id = c.id AND cl.label_id IN (${q.labelIds.map(() => '?').join(',')}))`);
    params.push(...q.labelIds);
  }
  if (q.columnIds.length) {
    where.push(`c.column_id IN (${q.columnIds.map(() => '?').join(',')})`);
    params.push(...q.columnIds);
  }
  for (const [col, values] of [
    ['priority', q.priorities],
    ['severity', q.severities],
  ] as const) {
    if (!values.length) continue;
    const named = values.filter((v) => v !== 'none');
    const parts = named.length ? [`c.${col} IN (${named.map(() => '?').join(',')})`] : [];
    if (values.includes('none')) parts.push(`c.${col} IS NULL`);
    where.push(`(${parts.join(' OR ')})`);
    params.push(...named);
  }
  if (q.from || q.to) {
    // Card-level date filter: anything recorded for the card in the range (edits, moves, work).
    const from = q.from ? startOfLocalDay(q.from, ctx.tz) : '0000';
    const to = q.to ? startOfLocalDay(addDays(q.to, 1), ctx.tz) : '9999';
    where.push(
      `EXISTS (SELECT 1 FROM activity a WHERE a.card_id = c.id AND a.retracted_at IS NULL
                 AND a.occurred_at >= ? AND a.occurred_at < ?)`,
    );
    params.push(from, to);
  }

  const base = `c.id, c.ticket_no, c.kind, c.title, c.column_id, col.name AS column_name, c.priority, c.severity, c.completed_at,
    c.archived_at, c.updated_at,
    (SELECT group_concat(cl.label_id, ',' ORDER BY l.position, l.id)
       FROM card_labels cl JOIN labels l ON l.id = cl.label_id WHERE cl.card_id = c.id) AS label_ids`;

  let rows: SearchRow[];
  if (fts) {
    const snippets = FIELDS.map((_, i) => `snippet(card_search, ${i}, char(2), char(3), '…', 16) AS s${i}`).join(', ');
    rows = ctx.db
      .prepare(
        `SELECT ${base}, ${snippets}
           FROM card_search JOIN cards c ON c.id = card_search.rowid JOIN columns col ON col.id = c.column_id
          WHERE card_search MATCH ? AND ${where.join(' AND ')}
          ORDER BY bm25(card_search, 10.0, 4.0, 2.0, 3.0, 1.0), c.updated_at DESC
          LIMIT ?`,
      )
      .all(fts, ...params, q.limit) as SearchRow[];
  } else {
    // Filters only (no text): most recently changed first.
    if (where.length === 1) return [];
    rows = ctx.db
      .prepare(
        `SELECT ${base} FROM cards c JOIN columns col ON col.id = c.column_id
          WHERE ${where.join(' AND ')} ORDER BY c.updated_at DESC LIMIT ?`,
      )
      .all(...params, q.limit) as SearchRow[];
  }

  return rows.map((r) => ({
    id: r.id,
    ticketNo: r.ticket_no,
    kind: r.kind,
    title: r.title,
    columnId: r.column_id,
    columnName: r.column_name,
    labelIds: r.label_ids ? r.label_ids.split(',').map(Number) : [],
    priority: r.priority,
    severity: r.severity,
    completedAt: r.completed_at,
    archivedAt: r.archived_at,
    updatedAt: r.updated_at,
    matches: FIELDS.flatMap((field, i) => {
      const s = r[`s${i}` as 's0'];
      return s && s.includes('\u0002') ? [{ field, snippet: s }] : [];
    }),
  }));
}

// ---------------------------------------------------------------------------------------------
// "Seen this before?": finished tickets that look like this one
// ---------------------------------------------------------------------------------------------

const SIMILAR_CANDIDATES = 20;
/** A word on more than this share of cards says nothing about what a ticket is about… */
const COMMON_SHARE = 0.15;
/** …but only judge that once there are enough cards for the share to mean anything. */
const COMMON_MIN_CARDS = 20;
const NOTE_PREVIEW = 300;
/** How much of the new ticket's description picks words, and how much is looked at to find it. */
const QUERY_TEXT = 500;
const QUERY_SCAN = 4000;
/** How much of a candidate's description is compared. */
const CANDIDATE_SCAN = 20_000;

/** Sorts after every word that starts with a given prefix. */
const AFTER_PREFIX = String.fromCodePoint(0x10ffff);

/**
 * The words among `terms` that appear on too many cards to tell tickets apart. A term of 4 or more
 * characters is a prefix ("fail" for failed, failing…); it counts as common when its most common
 * word is.
 */
function commonWords(ctx: Ctx, terms: string[]): Set<string> {
  const total = stmt(ctx.db, 'SELECT count(*) FROM card_search').pluck().get() as number;
  if (total < COMMON_MIN_CARDS || !terms.length) return new Set();
  // A temp table: per connection, nothing on disk, nothing in backups.
  ctx.db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS temp.card_search_vocab USING fts5vocab(main, card_search, row)');
  const exact = stmt(ctx.db, 'SELECT coalesce(max(doc), 0) FROM temp.card_search_vocab WHERE term = ?').pluck();
  const prefix = stmt(ctx.db, 'SELECT coalesce(max(doc), 0) FROM temp.card_search_vocab WHERE term >= ? AND term < ?').pluck();
  const docs = (t: string) => (t.length >= 4 ? prefix.get(t, `${t}${AFTER_PREFIX}`) : exact.get(t)) as number;
  return new Set(terms.filter((t) => docs(t) / total > COMMON_SHARE));
}

interface SimilarRow {
  id: number;
  ticket_no: string | null;
  title: string;
  description_md: string;
  resolution: string | null;
  resolution_md: string;
  completed_at: string;
  archived_at: string | null;
  parent_id: number | null;
}

/**
 * Finished tickets that look like the given one, best first. Any of its distinctive words may
 * match (title and description only; attachment names, work logs and checklists are noise here),
 * ranked by bm25 with the title counting most; then a candidate needs at least two of the words
 * (one, if there's only one), one of them from the title (see similarEnough). Archived tickets count:
 * "Archive all done" is where old fixes end up. Tickets already linked to this one are left out.
 */
export function similarCards(
  ctx: Ctx,
  input: { title: string; description: string; excludeId?: number; limit?: number },
): SimilarTicket[] {
  // Submitted titles start with their request type's name ("Plex – …"), which every ticket of that
  // type shares; the scaffolding around their answers likewise.
  const typeNames = stmt(ctx.db, 'SELECT name FROM request_types').pluck().all() as string[];
  const title = stripTypePrefix(input.title, typeNames);
  const picked = similarityTerms(`${title}\n${stripSubmitScaffolding(input.description.slice(0, QUERY_SCAN)).slice(0, QUERY_TEXT)}`);
  const titleTerms = similarityTerms(title);
  const common = commonWords(ctx, picked);
  const terms = picked.filter((t) => !common.has(t));
  if (!terms.length) return [];

  // Terms are folded letters and digits only, so they need no escaping inside the quotes.
  const match = `{title description} : (${terms.map((t) => `"${t}"${t.length >= 4 ? '*' : ''}`).join(' OR ')})`;
  const self = input.excludeId ?? 0;
  const rows = stmt(
    ctx.db,
    `SELECT c.id, c.ticket_no, c.title, c.description_md, c.resolution, c.resolution_md, c.completed_at, c.archived_at, c.parent_id
       FROM card_search JOIN cards c ON c.id = card_search.rowid
      WHERE card_search MATCH ? AND c.completed_at IS NOT NULL AND c.deleted_at IS NULL AND c.kind = 'ticket' AND c.id <> ?
        AND NOT EXISTS (SELECT 1 FROM card_links k
                         WHERE (k.from_card_id = ? AND k.to_card_id = c.id) OR (k.to_card_id = ? AND k.from_card_id = c.id))
      ORDER BY bm25(card_search, 10.0, 4.0, 1.0, 1.0, 1.0), c.completed_at DESC
      LIMIT ${SIMILAR_CANDIDATES}`,
  ).all(match, self, self, self) as SimilarRow[];

  const parentOf = stmt(ctx.db, 'SELECT id, ticket_no, title FROM cards WHERE id = ? AND deleted_at IS NULL');
  return rows
    .filter((r) => {
      // Title and description only: resolution reasons ("No longer needed", "Duplicate") and notes
      // aren't what a ticket is about.
      const words = `${stripTypePrefix(r.title, typeNames)}\n${stripSubmitScaffolding(r.description_md.slice(0, CANDIDATE_SCAN))}`;
      return similarEnough(terms, titleTerms, words);
    })
    .slice(0, input.limit ?? 5)
    .map((r) => {
      const parent = r.parent_id !== null ? (parentOf.get(r.parent_id) as { id: number; ticket_no: string | null; title: string } | undefined) : undefined;
      return {
        id: r.id,
        ticketNo: r.ticket_no,
        title: r.title,
        completedAt: r.completed_at,
        archived: r.archived_at !== null,
        resolution: r.resolution,
        note: plainTextPreview(r.resolution_md, NOTE_PREVIEW),
        parent: parent ? { id: parent.id, ticketNo: parent.ticket_no, title: parent.title } : null,
      };
    });
}

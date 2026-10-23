import { stmt } from '../db/connection';
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
  const card = stmt(db, 'SELECT id, title, description_md, deleted_at FROM cards WHERE id = ?').get(cardId) as
    | { id: number; title: string; description_md: string; deleted_at: string | null }
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

  // Extra searchable history: previous titles, attachment filenames, linked card titles.
  const history: string[] = [];
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
  ).run(cardId, card.title, card.description_md, checklistText.join('\n'), worklogs.join('\n\n'), [...new Set(history)].join('\n'));
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

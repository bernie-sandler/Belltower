import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listActivity } from '../src/services/activity';
import { archiveCard, createCard, deleteCard, getBoard, undeleteCard } from '../src/services/cards';
import { deleteLabel } from '../src/services/labels';
import { columnId, labelId, makeCtx } from './helpers';

let t: ReturnType<typeof makeCtx>;
beforeEach(() => {
  t = makeCtx();
});
afterEach(() => t.close());

const types = (cardId: number) => listActivity(t.ctx, cardId).map((e) => e.type).reverse();

describe('history edge cases', () => {
  it('rejects INSERT OR REPLACE over an existing activity row', () => {
    const card = createCard(t.ctx, { title: 'A' });
    const id = listActivity(t.ctx, card.id)[0]!.id;
    const now = t.ctx.clock.now().toISOString();
    expect(() =>
      t.ctx.db
        .prepare(
          `INSERT OR REPLACE INTO activity (id, card_id, kind, type, data, occurred_at, created_at)
           VALUES (?, ?, 'event', 'created', '{"forged":true}', ?, ?)`,
        )
        .run(id, card.id, now, now),
    ).toThrow(/append-only/);
  });

  it('logs a deleted label on trashed cards too, so a restored card explains itself', () => {
    const plex = labelId(t.ctx, 'Plex');
    const card = createCard(t.ctx, { title: 'A', labelIds: [plex] });
    deleteCard(t.ctx, card.id);
    deleteLabel(t.ctx, plex);
    undeleteCard(t.ctx, card.id);
    expect(types(card.id)).toEqual(['created', 'deleted', 'labels_changed', 'undeleted']);
  });

  it('keeps names as they were when the event happened', () => {
    const card = createCard(t.ctx, { title: 'A', labelIds: [labelId(t.ctx, 'Docker')] });
    t.ctx.db.prepare(`UPDATE columns SET name = 'Inbox' WHERE role = 'triage'`).run();
    expect(listActivity(t.ctx, card.id)[0]!.data).toMatchObject({ column: { name: 'Triage' } });
  });

  it('restoring an archived card from the Trash keeps it archived and off the board', () => {
    const card = createCard(t.ctx, { title: 'A', columnId: columnId(t.ctx, 'Done') });
    archiveCard(t.ctx, card.id);
    deleteCard(t.ctx, card.id);
    const back = undeleteCard(t.ctx, card.id);
    expect(back.archivedAt).not.toBeNull();
    expect(getBoard(t.ctx).cards).toHaveLength(0);
  });
});

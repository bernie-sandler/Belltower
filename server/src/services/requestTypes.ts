// Submit page request types: what a submitter picks first ("Plex", "Game servers"…), each with
// its own questions, title pattern and the labels every ticket of that type gets. Edited on the
// Settings page.

import type { RequestFieldDef, RequestType, RequestTypeBody } from '@tt/shared';
import { getSetting, setSetting, stmt } from '../db/connection';
import { badRequest, notFound } from '../errors';
import { nowIso, tx, type Ctx } from './context';

interface Row {
  id: number;
  name: string;
  description: string;
  title_pattern: string;
  fields: string;
  position: number;
  enabled: 0 | 1;
}

// tag_label_ids and type_label_id (schema 5) are unused since schema 10: request_type_labels holds
// a type's labels, and deleting a label removes it there.
function labelIdsOf(ctx: Ctx, id: number): number[] {
  return stmt(
    ctx.db,
    `SELECT t.label_id FROM request_type_labels t JOIN labels l ON l.id = t.label_id
      WHERE t.request_type_id = ? ORDER BY l.position, l.id`,
  )
    .pluck()
    .all(id) as number[];
}

function toType(ctx: Ctx, r: Row): RequestType {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    titlePattern: r.title_pattern,
    fields: JSON.parse(r.fields) as RequestFieldDef[],
    labelIds: labelIdsOf(ctx, r.id),
    position: r.position,
    enabled: r.enabled === 1,
  };
}

export function listRequestTypes(ctx: Ctx): RequestType[] {
  return (stmt(ctx.db, 'SELECT * FROM request_types ORDER BY position, id').all() as Row[]).map((r) => toType(ctx, r));
}

export function getRequestType(ctx: Ctx, id: number): RequestType {
  const row = stmt(ctx.db, 'SELECT * FROM request_types WHERE id = ?').get(id) as Row | undefined;
  if (!row) throw notFound('Request type not found');
  return toType(ctx, row);
}

function setLabels(ctx: Ctx, id: number, labelIds: number[]): void {
  for (const l of labelIds) {
    if (!stmt(ctx.db, 'SELECT 1 FROM labels WHERE id = ?').get(l)) throw badRequest('validation', `Unknown label id ${l}`);
  }
  stmt(ctx.db, 'DELETE FROM request_type_labels WHERE request_type_id = ?').run(id);
  const add = stmt(ctx.db, 'INSERT INTO request_type_labels (request_type_id, label_id) VALUES (?, ?)');
  for (const l of new Set(labelIds)) add.run(id, l);
}

export function createRequestType(ctx: Ctx, body: RequestTypeBody): RequestType {
  return tx(ctx, () => {
    const now = nowIso(ctx);
    const pos = stmt(ctx.db, 'SELECT coalesce(max(position), -1) + 1 FROM request_types').pluck().get() as number;
    const id = Number(
      stmt(
        ctx.db,
        `INSERT INTO request_types (name, description, title_pattern, fields, position, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(body.name, body.description, body.titlePattern, JSON.stringify(body.fields), pos, body.enabled ? 1 : 0, now, now)
        .lastInsertRowid,
    );
    setLabels(ctx, id, body.labelIds ?? []);
    return getRequestType(ctx, id);
  });
}

export function updateRequestType(ctx: Ctx, id: number, body: RequestTypeBody): RequestType {
  getRequestType(ctx, id);
  return tx(ctx, () => {
    stmt(
      ctx.db,
      `UPDATE request_types SET name = ?, description = ?, title_pattern = ?, fields = ?, enabled = ?, updated_at = ? WHERE id = ?`,
    ).run(body.name, body.description, body.titlePattern, JSON.stringify(body.fields), body.enabled ? 1 : 0, nowIso(ctx), id);
    // Left out (an app tab opened before 1.5.0-rc.4): keep the saved labels.
    if (body.labelIds) setLabels(ctx, id, body.labelIds);
    return getRequestType(ctx, id);
  });
}

export function deleteRequestType(ctx: Ctx, id: number): void {
  getRequestType(ctx, id);
  stmt(ctx.db, 'DELETE FROM request_types WHERE id = ?').run(id);
}

export function reorderRequestTypes(ctx: Ctx, ids: number[]): RequestType[] {
  const existing = stmt(ctx.db, 'SELECT id FROM request_types').pluck().all() as number[];
  if (ids.length !== existing.length || new Set(ids).size !== ids.length || !ids.every((id) => existing.includes(id))) {
    throw badRequest('validation', 'ids must list every request type exactly once');
  }
  tx(ctx, () => ids.forEach((id, i) => stmt(ctx.db, 'UPDATE request_types SET position = ? WHERE id = ?').run(i, id)));
  return listRequestTypes(ctx);
}

const TRIED: RequestFieldDef = { key: 'tried', label: 'What have you tried so far?', help: '', kind: 'long', required: false, options: [] };
const STARTED: RequestFieldDef = { key: 'started', label: 'When did it start?', help: '', kind: 'datetime', required: false, options: [] };

/** Starting point, based on the owner's old Discord support templates. All editable in Settings. */
const DEFAULT_TYPES: Omit<RequestTypeBody, 'labelIds' | 'enabled'>[] = [
  {
    name: 'General',
    description: 'A question, a request, or an idea',
    titlePattern: 'General – {summary}',
    fields: [
      {
        key: 'where',
        label: 'Where does this apply?',
        help: '',
        kind: 'choice',
        required: true,
        options: ['Game server', 'Media library (Plex)', 'Discord', 'Something else'],
      },
      { ...TRIED, label: 'Steps taken so far (if any)' },
      { key: 'extra', label: 'Anything else that might help?', help: '', kind: 'long', required: false, options: [] },
    ],
  },
  {
    name: 'Plex',
    description: 'Playback, missing episodes, subtitles, audio…',
    titlePattern: 'Plex – {title} – {summary}',
    fields: [
      { key: 'title', label: 'Movie or TV show', help: '', kind: 'short', required: true, options: [] },
      { key: 'media', label: 'Media type', help: '', kind: 'choice', required: true, options: ['Movie', 'TV show'] },
      { key: 'episode', label: 'Season and episode', help: 'For TV shows, e.g. S02E05', kind: 'short', required: false, options: [] },
      {
        key: 'device',
        label: 'Device or app',
        help: '',
        kind: 'choice',
        required: true,
        options: ['Plex on a computer', 'Plex in a web browser', 'Roku', 'Phone or tablet', 'Smart TV', 'Something else'],
      },
      STARTED,
      TRIED,
    ],
  },
  {
    name: 'Game servers',
    description: 'Lag, crashes, can’t connect, bans…',
    titlePattern: 'Game Servers – {game} – {summary}',
    fields: [
      { key: 'game', label: 'Game', help: '', kind: 'short', required: true, options: [] },
      { key: 'server', label: 'Server name', help: '', kind: 'short', required: false, options: [] },
      {
        key: 'issue',
        label: 'Issue type',
        help: '',
        kind: 'choice',
        required: true,
        options: ['Lag or performance', 'Crashes', 'Can’t connect', 'Server bug', 'Ban or appeal', 'Something else'],
      },
      STARTED,
      { ...TRIED, help: 'Restarted the game, cleared the cache, …' },
    ],
  },
];

/** Adds the default request types once (a restored backup brings its own and the flag with it). */
export function seedRequestTypes(ctx: Ctx): boolean {
  if (getSetting(ctx.db, 'request_types_seeded')) return false;
  tx(ctx, () => {
    if ((stmt(ctx.db, 'SELECT count(*) FROM request_types').pluck().get() as number) === 0) {
      for (const t of DEFAULT_TYPES) createRequestType(ctx, { ...t, labelIds: [], enabled: true });
    }
    setSetting(ctx.db, 'request_types_seeded', '1');
  });
  return true;
}

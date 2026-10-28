// Submit page request types: what a submitter picks first ("Plex", "Game servers"…), each with
// its own questions, tag choices and title pattern. Edited on the Settings page.

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
  tag_label_ids: string;
  type_label_id: number | null;
  position: number;
  enabled: 0 | 1;
}

function toType(ctx: Ctx, r: Row): RequestType {
  // Labels can be deleted after a type was saved; only offer ones that still exist.
  const labels = new Set(stmt(ctx.db, 'SELECT id FROM labels').pluck().all() as number[]);
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    titlePattern: r.title_pattern,
    fields: JSON.parse(r.fields) as RequestFieldDef[],
    tagLabelIds: (JSON.parse(r.tag_label_ids) as number[]).filter((id) => labels.has(id)),
    typeLabelId: r.type_label_id,
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

function checkLabels(ctx: Ctx, body: RequestTypeBody): void {
  const ids = [...body.tagLabelIds, ...(body.typeLabelId !== null ? [body.typeLabelId] : [])];
  for (const id of ids) {
    if (!stmt(ctx.db, 'SELECT 1 FROM labels WHERE id = ?').get(id)) throw badRequest('validation', `Unknown label id ${id}`);
  }
}

export function createRequestType(ctx: Ctx, body: RequestTypeBody): RequestType {
  checkLabels(ctx, body);
  return tx(ctx, () => {
    const now = nowIso(ctx);
    const pos = stmt(ctx.db, 'SELECT coalesce(max(position), -1) + 1 FROM request_types').pluck().get() as number;
    const id = Number(
      stmt(
        ctx.db,
        `INSERT INTO request_types (name, description, title_pattern, fields, tag_label_ids, type_label_id, position, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        body.name,
        body.description,
        body.titlePattern,
        JSON.stringify(body.fields),
        JSON.stringify([...new Set(body.tagLabelIds)]),
        body.typeLabelId,
        pos,
        body.enabled ? 1 : 0,
        now,
        now,
      ).lastInsertRowid,
    );
    return getRequestType(ctx, id);
  });
}

export function updateRequestType(ctx: Ctx, id: number, body: RequestTypeBody): RequestType {
  getRequestType(ctx, id);
  checkLabels(ctx, body);
  stmt(
    ctx.db,
    `UPDATE request_types SET name = ?, description = ?, title_pattern = ?, fields = ?, tag_label_ids = ?, type_label_id = ?,
       enabled = ?, updated_at = ? WHERE id = ?`,
  ).run(
    body.name,
    body.description,
    body.titlePattern,
    JSON.stringify(body.fields),
    JSON.stringify([...new Set(body.tagLabelIds)]),
    body.typeLabelId,
    body.enabled ? 1 : 0,
    nowIso(ctx),
    id,
  );
  return getRequestType(ctx, id);
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
const DEFAULT_TYPES: Omit<RequestTypeBody, 'tagLabelIds' | 'typeLabelId' | 'enabled'>[] = [
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
      for (const t of DEFAULT_TYPES) createRequestType(ctx, { ...t, tagLabelIds: [], typeLabelId: null, enabled: true });
    }
    setSetting(ctx.db, 'request_types_seeded', '1');
  });
  return true;
}

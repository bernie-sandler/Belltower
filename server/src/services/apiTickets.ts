// GET /api/v1/cards and /api/v1/cards/:ref: read tickets back, so a bot that opened one can tell
// when it's done. Status fields only (no description, notes or people), with the same state the
// status page and the summary use (ticketStates). Work cards aren't part of v1. A token of a
// tag-restricted member sees only the cards that member can see; others answer like missing ones.

import {
  API_TICKETS_PAGE,
  apiTicketsCursor,
  PRIORITY_CODES,
  SEVERITY_CODES,
  type ApiTicket,
  type ApiTicketList,
  type ApiTicketSource,
  type ApiTicketsQuery,
  type Priority,
  type Severity,
} from '@tt/shared';
import { stmt } from '../db/connection';
import { notFound } from '../errors';
import type { Ctx } from './context';
import { visibleSql } from './scope';
import { ticketStates } from './ticketState';

interface Row {
  id: number;
  ticket_no: string | null;
  title: string;
  column_id: number;
  column_name: string;
  priority: Priority | null;
  severity: Severity | null;
  due_date: string | null;
  resolution: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  archived_at: string | null;
  deleted_at: string | null;
  source: 'manual' | 'recurring' | 'api';
  source_ref: string | null;
}

const COLUMNS = `c.id, c.ticket_no, c.title, c.column_id, col.name AS column_name, c.priority, c.severity, c.due_date,
  c.resolution, c.created_at, c.updated_at, c.completed_at, c.archived_at, c.deleted_at, c.source,
  c.source_ref`;
const FROM = `FROM cards c JOIN columns col ON col.id = c.column_id`;

/** The creation history's "via" of a submit-page ticket: "submit page" or "submit page (their name)". */
const SUBMIT_VIA = /^submit page(?: \((.*)\))?$/s;

/**
 * Submit-page tickets among `rows`, with the name the submitter typed and the link's `?ref=` (each
 * or null). The submit page,
 * /api/v1 and card imports all store source 'api'. The submit page sets source_ref 'submit', which an
 * /api/v1 dedupeKey could also be, so the creation event's "via" has to agree as well.
 */
function submitters(ctx: Ctx, rows: Row[]): Map<number, { name: string | null; ref: string | null }> {
  const out = new Map<number, { name: string | null; ref: string | null }>();
  const ids = rows.filter((r) => r.source === 'api' && r.source_ref === 'submit').map((r) => r.id);
  if (!ids.length) return out;
  const vias = stmt(
    ctx.db,
    `SELECT card_id, json_extract(data, '$.via') AS via, json_extract(data, '$.ref') AS ref FROM activity
      WHERE type = 'created' AND card_id IN (SELECT value FROM json_each(?))`,
  ).all(JSON.stringify(ids)) as { card_id: number; via: unknown; ref: unknown }[];
  for (const v of vias) {
    const m = typeof v.via === 'string' ? SUBMIT_VIA.exec(v.via) : null;
    if (m) out.set(v.card_id, { name: m[1] || null, ref: typeof v.ref === 'string' ? v.ref : null });
  }
  return out;
}

/** Rows → ApiTicket, with a fixed number of queries however many rows there are. */
function toTickets(ctx: Ctx, rows: Row[]): ApiTicket[] {
  if (!rows.length) return [];
  const states = ticketStates(ctx, rows);
  const submitted = submitters(ctx, rows);
  const labels = new Map<number, string[]>();
  const labelRows = stmt(
    ctx.db,
    `SELECT cl.card_id, l.name FROM card_labels cl JOIN labels l ON l.id = cl.label_id
      WHERE cl.card_id IN (SELECT value FROM json_each(?)) ORDER BY l.position, l.id`,
  ).all(JSON.stringify(rows.map((r) => r.id))) as { card_id: number; name: string }[];
  for (const l of labelRows) {
    const list = labels.get(l.card_id);
    if (list) list.push(l.name);
    else labels.set(l.card_id, [l.name]);
  }
  return rows.map((r, i) => {
    const state = states[i]!;
    return {
      id: r.id,
      ticketNo: r.ticket_no,
      title: r.title,
      state,
      resolution: state === 'done' ? r.resolution : null,
      column: { id: r.column_id, name: r.column_name },
      priority: r.priority ? PRIORITY_CODES[r.priority] : null,
      severity: r.severity ? SEVERITY_CODES[r.severity] : null,
      labels: labels.get(r.id) ?? [],
      due: r.due_date,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      completedAt: r.completed_at,
      archivedAt: r.archived_at,
      deletedAt: r.deleted_at,
      source: (submitted.has(r.id) ? 'submit' : r.source) satisfies ApiTicketSource,
      submitter: submitted.get(r.id)?.name ?? null,
      submitRef: submitted.get(r.id)?.ref ?? null,
    };
  });
}

/**
 * One ticket by ticket number (any letter case) or, failing that, by id when `ref` is all digits.
 * A ticket number wins, since a custom format can make digits-only numbers ("{N}").
 */
export function apiTicket(ctx: Ctx, ref: string): ApiTicket {
  const r = ref.trim();
  if (!r || r.length > 60) throw notFound('No such ticket');
  const where = `c.kind = 'ticket' AND ${visibleSql(ctx)}`;
  let row = stmt(ctx.db, `SELECT ${COLUMNS} ${FROM} WHERE c.ticket_no = ? COLLATE NOCASE AND ${where} ORDER BY c.id DESC LIMIT 1`).get(r) as
    | Row
    | undefined;
  if (!row && /^[1-9]\d{0,11}$/.test(r)) {
    row = stmt(ctx.db, `SELECT ${COLUMNS} ${FROM} WHERE c.id = ? AND ${where}`).get(Number(r)) as Row | undefined;
  }
  if (!row) throw notFound('No such ticket');
  return toTickets(ctx, [row])[0]!;
}

/**
 * Tickets by id and/or changed since a time. With `ids` alone: those tickets (missing ones left
 * out), in id order. With `updatedSince` (updatedAt at or after it) or `cursor` (strictly after the
 * cursor's (updatedAt, id), so tickets sharing one timestamp can't stall paging): oldest change
 * first, at most API_TICKETS_PAGE, with `more` and the `next` cursor when there are further ones.
 */
export function apiTickets(ctx: Ctx, q: ApiTicketsQuery): ApiTicketList {
  const conds = [`c.kind = 'ticket'`, visibleSql(ctx)];
  const params: unknown[] = [];
  if (q.ids) {
    conds.push('c.id IN (SELECT value FROM json_each(?))');
    params.push(JSON.stringify(q.ids));
  }
  let rows: Row[];
  let more = false;
  if (q.updatedSince || q.cursor) {
    if (q.cursor) {
      conds.push('(c.updated_at > ? OR (c.updated_at = ? AND c.id > ?))');
      params.push(q.cursor.updatedAt, q.cursor.updatedAt, q.cursor.id);
    } else {
      conds.push('c.updated_at >= ?');
      params.push(q.updatedSince);
    }
    rows = stmt(ctx.db, `SELECT ${COLUMNS} ${FROM} WHERE ${conds.join(' AND ')} ORDER BY c.updated_at, c.id LIMIT ?`).all(
      ...params,
      API_TICKETS_PAGE + 1,
    ) as Row[];
    more = rows.length > API_TICKETS_PAGE;
    if (more) rows = rows.slice(0, API_TICKETS_PAGE);
  } else {
    rows = stmt(ctx.db, `SELECT ${COLUMNS} ${FROM} WHERE ${conds.join(' AND ')} ORDER BY c.id`).all(...params) as Row[];
  }
  const last = rows[rows.length - 1];
  return {
    cards: toTickets(ctx, rows),
    more,
    next: more && last ? apiTicketsCursor(last.updated_at, last.id) : null,
    generatedAt: ctx.clock.now().toISOString(),
  };
}

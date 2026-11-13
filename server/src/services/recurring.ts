// Recurring maintenance templates and the scheduler that turns them into Triage cards.
//
// Rules:
//  - A template is due when today (app time zone) reaches its next_run_date.
//  - One card per occurrence: template_runs has UNIQUE(template_id, occurrence_date), so two
//    overlapping ticks can't both create one.
//  - No duplicates: if the card from an earlier run (or "Create now") is still open — not done,
//    not archived, not in the Trash — the occurrence is skipped and the open card gets a note.
//  - After downtime only the latest missed occurrence is handled (one card, not a burst).
//  - "Create now" makes a card immediately and leaves the schedule alone.
//  - Pausing stops runs; resuming (or editing the schedule) restarts from today, without catch-up.
//  - A tag-restricted member sees only the templates carrying one of their tags (the cards they
//    make carry the same tags), and can't create, change, delete or run any.

import type { CardDetail, Priority, RecurringTemplate, TemplateBody, TemplateChecklist, UpdateTemplateBody } from '@tt/shared';
import { stmt } from '../db/connection';
import { badRequest, conflict, notFound } from '../errors';
import { addDays, localDateOf } from '../lib/localdate';
import { firstAfter, firstOnOrAfter, latestOnOrBefore, upcoming, type Schedule } from '../lib/recurrence';
import { recordEvent } from './activity';
import { createCard } from './cards';
import { nowIso, tx, type Ctx } from './context';
import { assertUnrestricted, canSeeCard, visibleSql } from './scope';

interface TemplateRow {
  id: number;
  title: string;
  description_md: string;
  priority: Priority | null;
  checklist_template: string;
  interval_unit: 'day' | 'week' | 'month';
  interval_count: number;
  start_date: string;
  next_run_date: string;
  due_in_days: number | null;
  enabled: 0 | 1;
  created_at: string;
  updated_at: string;
}

const today = (ctx: Ctx) => localDateOf(ctx.clock.now(), ctx.tz);

const scheduleOf = (r: Pick<TemplateRow, 'start_date' | 'interval_unit' | 'interval_count'>): Schedule => ({
  startDate: r.start_date,
  unit: r.interval_unit,
  count: r.interval_count,
});

function row(ctx: Ctx, id: number): TemplateRow {
  const r = stmt(ctx.db, 'SELECT * FROM recurring_templates WHERE id = ?').get(id) as TemplateRow | undefined;
  if (!r) throw notFound('Template not found');
  return r;
}

function labelIdsOf(ctx: Ctx, id: number): number[] {
  return stmt(
    ctx.db,
    `SELECT t.label_id FROM recurring_template_labels t JOIN labels l ON l.id = t.label_id
      WHERE t.template_id = ? ORDER BY l.position, l.id`,
  )
    .pluck()
    .all(id) as number[];
}

/**
 * SQL that is true for the templates (aliased `t`) `ctx` may see: all of them, or for a
 * tag-restricted member those carrying one of their tags. The id is written in as visibleSql does.
 */
function templateVisibleSql(ctx: Ctx): string {
  const scope = ctx.scope;
  if (!scope) return '1';
  if (!Number.isSafeInteger(scope.userId)) throw new Error('templateVisibleSql: bad user id');
  return `EXISTS (SELECT 1 FROM recurring_template_labels stl JOIN user_labels sul ON sul.label_id = stl.label_id
                   WHERE stl.template_id = t.id AND sul.user_id = ${scope.userId})`;
}

/** The open card made from this template, if any (one `ctx` can see: the scheduler sees all). */
function openCardId(ctx: Ctx, templateId: number): number | null {
  return (
    (stmt(
      ctx.db,
      `SELECT c.id FROM cards c WHERE c.template_id = ? AND c.deleted_at IS NULL AND c.archived_at IS NULL
          AND c.completed_at IS NULL AND ${visibleSql(ctx)} ORDER BY c.id DESC LIMIT 1`,
    )
      .pluck()
      .get(templateId) as number | undefined) ?? null
  );
}

function toTemplate(ctx: Ctx, r: TemplateRow): RecurringTemplate {
  const last = stmt(
    ctx.db,
    'SELECT ran_at, outcome, card_id FROM template_runs WHERE template_id = ? ORDER BY ran_at DESC, id DESC LIMIT 1',
  ).get(r.id) as { ran_at: string; outcome: 'created' | 'skipped_open' | 'manual'; card_id: number | null } | undefined;
  // The last run's card stays unnamed for someone who can't see it.
  if (last && last.card_id !== null && ctx.scope && !canSeeCard(ctx, last.card_id)) last.card_id = null;
  return {
    id: r.id,
    title: r.title,
    description: r.description_md,
    priority: r.priority,
    labelIds: labelIdsOf(ctx, r.id),
    checklists: JSON.parse(r.checklist_template) as TemplateChecklist[],
    intervalUnit: r.interval_unit,
    intervalCount: r.interval_count,
    startDate: r.start_date,
    nextRunDate: r.next_run_date,
    dueInDays: r.due_in_days,
    enabled: r.enabled === 1,
    openCardId: openCardId(ctx, r.id),
    lastRun: last ? { at: last.ran_at, outcome: last.outcome, cardId: last.card_id } : null,
    upcoming: upcoming(scheduleOf(r), r.next_run_date, 3),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listTemplates(ctx: Ctx): RecurringTemplate[] {
  return (
    stmt(ctx.db, `SELECT t.* FROM recurring_templates t WHERE ${templateVisibleSql(ctx)} ORDER BY t.title COLLATE NOCASE, t.id`).all() as TemplateRow[]
  ).map((r) => toTemplate(ctx, r));
}

/** 404 for a template a tag-restricted member can't see, as for one that doesn't exist. */
export function getTemplate(ctx: Ctx, id: number): RecurringTemplate {
  const r = stmt(ctx.db, `SELECT t.* FROM recurring_templates t WHERE t.id = ? AND ${templateVisibleSql(ctx)}`).get(id) as
    | TemplateRow
    | undefined;
  if (!r) throw notFound('Template not found');
  return toTemplate(ctx, r);
}

const MANAGE = 'manage recurring templates';

function setLabels(ctx: Ctx, id: number, labelIds: number[]): void {
  for (const l of labelIds) {
    if (!stmt(ctx.db, 'SELECT 1 FROM labels WHERE id = ?').get(l)) throw badRequest('validation', `Unknown label id ${l}`);
  }
  stmt(ctx.db, 'DELETE FROM recurring_template_labels WHERE template_id = ?').run(id);
  const add = stmt(ctx.db, 'INSERT INTO recurring_template_labels (template_id, label_id) VALUES (?, ?)');
  for (const l of new Set(labelIds)) add.run(id, l);
}

export function createTemplate(ctx: Ctx, body: TemplateBody): RecurringTemplate {
  assertUnrestricted(ctx, MANAGE);
  return tx(ctx, () => {
    const now = nowIso(ctx);
    const next = firstOnOrAfter(
      { startDate: body.startDate, unit: body.intervalUnit, count: body.intervalCount },
      today(ctx),
    );
    const id = Number(
      stmt(
        ctx.db,
        `INSERT INTO recurring_templates (title, description_md, priority, checklist_template, interval_unit,
           interval_count, start_date, next_run_date, due_in_days, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        body.title,
        body.description,
        body.priority,
        JSON.stringify(body.checklists),
        body.intervalUnit,
        body.intervalCount,
        body.startDate,
        next,
        body.dueInDays,
        body.enabled ? 1 : 0,
        now,
        now,
      ).lastInsertRowid,
    );
    setLabels(ctx, id, body.labelIds);
    return getTemplate(ctx, id);
  });
}

export function updateTemplate(ctx: Ctx, id: number, patch: UpdateTemplateBody): RecurringTemplate {
  assertUnrestricted(ctx, MANAGE);
  return tx(ctx, () => {
    const r = row(ctx, id);
    const next: TemplateRow = {
      ...r,
      title: patch.title ?? r.title,
      description_md: patch.description ?? r.description_md,
      priority: patch.priority !== undefined ? patch.priority : r.priority,
      checklist_template: patch.checklists ? JSON.stringify(patch.checklists) : r.checklist_template,
      interval_unit: patch.intervalUnit ?? r.interval_unit,
      interval_count: patch.intervalCount ?? r.interval_count,
      start_date: patch.startDate ?? r.start_date,
      due_in_days: patch.dueInDays !== undefined ? patch.dueInDays : r.due_in_days,
      enabled: patch.enabled === undefined ? r.enabled : patch.enabled ? 1 : 0,
    };
    const scheduleChanged =
      next.interval_unit !== r.interval_unit || next.interval_count !== r.interval_count || next.start_date !== r.start_date;
    const resumed = next.enabled === 1 && r.enabled === 0;
    // Restart from today (no catch-up for the time it was paused or differently scheduled).
    if (scheduleChanged || resumed) next.next_run_date = firstOnOrAfter(scheduleOf(next), today(ctx));
    stmt(
      ctx.db,
      `UPDATE recurring_templates SET title = ?, description_md = ?, priority = ?, checklist_template = ?,
         interval_unit = ?, interval_count = ?, start_date = ?, next_run_date = ?, due_in_days = ?, enabled = ?,
         updated_at = ? WHERE id = ?`,
    ).run(
      next.title,
      next.description_md,
      next.priority,
      next.checklist_template,
      next.interval_unit,
      next.interval_count,
      next.start_date,
      next.next_run_date,
      next.due_in_days,
      next.enabled,
      nowIso(ctx),
      id,
    );
    if (patch.labelIds) setLabels(ctx, id, patch.labelIds);
    return getTemplate(ctx, id);
  });
}

/** Deletes a template; the cards it made stay (they just lose the link). */
export function deleteTemplate(ctx: Ctx, id: number): void {
  assertUnrestricted(ctx, MANAGE);
  tx(ctx, () => {
    row(ctx, id);
    stmt(ctx.db, 'DELETE FROM recurring_templates WHERE id = ?').run(id);
  });
}

function makeCard(ctx: Ctx, r: TemplateRow, occurrenceDate: string): CardDetail {
  return createCard(
    ctx,
    {
      title: r.title,
      description: r.description_md,
      labelIds: labelIdsOf(ctx, r.id),
      priority: r.priority,
      dueDate: r.due_in_days === null ? null : addDays(occurrenceDate, r.due_in_days),
      checklists: JSON.parse(r.checklist_template) as TemplateChecklist[],
    },
    { source: 'recurring', templateId: r.id, templateTitle: r.title },
  );
}

/** "Create now": a card right away; the schedule is unchanged. Refuses while one is open unless forced. */
export function runTemplateNow(ctx: Ctx, id: number, force = false): CardDetail {
  assertUnrestricted(ctx, MANAGE);
  return tx(ctx, () => {
    const r = row(ctx, id);
    const open = openCardId(ctx, id);
    if (open !== null && !force) {
      throw conflict('open_instance', 'A card from this template is still open', { cardId: open });
    }
    const card = makeCard(ctx, r, today(ctx));
    stmt(
      ctx.db,
      `INSERT INTO template_runs (template_id, occurrence_date, outcome, card_id, ran_at) VALUES (?, NULL, 'manual', ?, ?)`,
    ).run(id, card.id, nowIso(ctx));
    return card;
  });
}

export interface TickResult {
  created: number[];
  skipped: number[];
}

/** Handles every enabled template that is due today (or overdue after downtime). */
export function runDueTemplates(ctx: Ctx): TickResult {
  const result: TickResult = { created: [], skipped: [] };
  const day = today(ctx);
  const due = stmt(
    ctx.db,
    'SELECT * FROM recurring_templates WHERE enabled = 1 AND next_run_date <= ? ORDER BY id',
  ).all(day) as TemplateRow[];

  for (const r of due) {
    tx(ctx, () => {
      const schedule = scheduleOf(r);
      const occ = latestOnOrBefore(schedule, day) ?? r.next_run_date;
      const claimed = stmt(
        ctx.db,
        `INSERT INTO template_runs (template_id, occurrence_date, outcome, card_id, ran_at)
         VALUES (?, ?, 'created', NULL, ?) ON CONFLICT (template_id, occurrence_date) DO NOTHING`,
      ).run(r.id, occ, nowIso(ctx));

      if (claimed.changes === 1) {
        const runId = Number(claimed.lastInsertRowid);
        const open = openCardId(ctx, r.id);
        if (open !== null) {
          stmt(ctx.db, `UPDATE template_runs SET outcome = 'skipped_open', card_id = ? WHERE id = ?`).run(open, runId);
          recordEvent(ctx, open, 'recurrence_skipped', { templateId: r.id, templateTitle: r.title, occurrenceDate: occ });
          result.skipped.push(r.id);
        } else {
          const card = makeCard(ctx, r, occ);
          stmt(ctx.db, 'UPDATE template_runs SET card_id = ? WHERE id = ?').run(card.id, runId);
          result.created.push(card.id);
        }
      }
      stmt(ctx.db, 'UPDATE recurring_templates SET next_run_date = ? WHERE id = ?').run(firstAfter(schedule, day), r.id);
    });
  }
  return result;
}

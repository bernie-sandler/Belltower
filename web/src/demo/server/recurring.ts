// Mirrors server/src/services/recurring.ts: maintenance templates and the scheduler that turns
// them into Triage cards. The server's scheduler ticks every few minutes; the demo runs the same
// check whenever the board loads.

import type { CardDetail, RecurringTemplate, TemplateBody, UpdateTemplateBody } from '@tt/shared';
import { recordEvent } from './activity';
import { createCard } from './cards';
import { nextId, nowIso, type Ctx, type TemplateRow } from './db';
import { badRequest, conflict, notFound } from './errors';
import { labelIdsOf } from './labels';
import { addDays, firstAfter, firstOnOrAfter, latestOnOrBefore, localDateOf, upcoming, type Schedule } from './lib';

const today = (ctx: Ctx) => localDateOf(ctx.now(), ctx.tz);

const scheduleOf = (r: Pick<TemplateRow, 'startDate' | 'intervalUnit' | 'intervalCount'>): Schedule => ({
  startDate: r.startDate,
  unit: r.intervalUnit,
  count: r.intervalCount,
});

function row(ctx: Ctx, id: number): TemplateRow {
  const r = ctx.s.templates.find((t) => t.id === id);
  if (!r) throw notFound('Template not found');
  return r;
}

/** The open card made from this template, if any. */
function openCardId(ctx: Ctx, templateId: number): number | null {
  const open = ctx.s.cards
    .filter((c) => c.templateId === templateId && !c.deletedAt && !c.archivedAt && !c.completedAt)
    .sort((a, b) => b.id - a.id)[0];
  return open?.id ?? null;
}

function toTemplate(ctx: Ctx, r: TemplateRow): RecurringTemplate {
  const last = ctx.s.templateRuns
    .filter((x) => x.templateId === r.id)
    .sort((a, b) => b.ranAt.localeCompare(a.ranAt) || b.id - a.id)[0];
  return {
    id: r.id,
    title: r.title,
    description: r.descriptionMd,
    priority: r.priority,
    labelIds: labelIdsOf(ctx, r.labelIds),
    checklists: structuredClone(r.checklists),
    intervalUnit: r.intervalUnit,
    intervalCount: r.intervalCount,
    startDate: r.startDate,
    nextRunDate: r.nextRunDate,
    dueInDays: r.dueInDays,
    enabled: r.enabled,
    openCardId: openCardId(ctx, r.id),
    lastRun: last ? { at: last.ranAt, outcome: last.outcome, cardId: last.cardId } : null,
    upcoming: upcoming(scheduleOf(r), r.nextRunDate, 3),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function listTemplates(ctx: Ctx): RecurringTemplate[] {
  return [...ctx.s.templates]
    .sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()) || a.id - b.id)
    .map((r) => toTemplate(ctx, r));
}

export function getTemplate(ctx: Ctx, id: number): RecurringTemplate {
  return toTemplate(ctx, row(ctx, id));
}

function checkLabels(ctx: Ctx, labelIds: number[]): number[] {
  for (const l of labelIds) {
    if (!ctx.s.labels.some((x) => x.id === l)) throw badRequest('validation', `Unknown label id ${l}`);
  }
  return [...new Set(labelIds)];
}

export function createTemplate(ctx: Ctx, body: TemplateBody): RecurringTemplate {
  const now = nowIso(ctx);
  const labelIds = checkLabels(ctx, body.labelIds);
  const r: TemplateRow = {
    id: nextId(ctx, 'templates'),
    title: body.title,
    descriptionMd: body.description,
    priority: body.priority,
    checklists: body.checklists,
    intervalUnit: body.intervalUnit,
    intervalCount: body.intervalCount,
    startDate: body.startDate,
    nextRunDate: firstOnOrAfter({ startDate: body.startDate, unit: body.intervalUnit, count: body.intervalCount }, today(ctx)),
    dueInDays: body.dueInDays,
    enabled: body.enabled,
    labelIds,
    createdAt: now,
    updatedAt: now,
  };
  ctx.s.templates.push(r);
  return getTemplate(ctx, r.id);
}

export function updateTemplate(ctx: Ctx, id: number, patch: UpdateTemplateBody): RecurringTemplate {
  const r = row(ctx, id);
  const labelIds = patch.labelIds ? checkLabels(ctx, patch.labelIds) : r.labelIds;
  const next: TemplateRow = {
    ...r,
    title: patch.title ?? r.title,
    descriptionMd: patch.description ?? r.descriptionMd,
    priority: patch.priority !== undefined ? patch.priority : r.priority,
    checklists: patch.checklists ?? r.checklists,
    intervalUnit: patch.intervalUnit ?? r.intervalUnit,
    intervalCount: patch.intervalCount ?? r.intervalCount,
    startDate: patch.startDate ?? r.startDate,
    dueInDays: patch.dueInDays !== undefined ? patch.dueInDays : r.dueInDays,
    enabled: patch.enabled ?? r.enabled,
    labelIds,
    updatedAt: nowIso(ctx),
  };
  const scheduleChanged =
    next.intervalUnit !== r.intervalUnit || next.intervalCount !== r.intervalCount || next.startDate !== r.startDate;
  if (scheduleChanged || (next.enabled && !r.enabled)) next.nextRunDate = firstOnOrAfter(scheduleOf(next), today(ctx));
  Object.assign(r, next);
  return getTemplate(ctx, id);
}

/** Deletes a template; the cards it made stay. */
export function deleteTemplate(ctx: Ctx, id: number): void {
  row(ctx, id);
  ctx.s.templates = ctx.s.templates.filter((t) => t.id !== id);
  ctx.s.templateRuns = ctx.s.templateRuns.filter((t) => t.templateId !== id);
  // The server's foreign key is ON DELETE SET NULL.
  for (const c of ctx.s.cards) if (c.templateId === id) c.templateId = null;
}

function makeCard(ctx: Ctx, r: TemplateRow, occurrenceDate: string): CardDetail {
  return createCard(
    ctx,
    {
      title: r.title,
      description: r.descriptionMd,
      labelIds: labelIdsOf(ctx, r.labelIds),
      priority: r.priority,
      dueDate: r.dueInDays === null ? null : addDays(occurrenceDate, r.dueInDays),
      checklists: structuredClone(r.checklists),
    },
    { source: 'recurring', templateId: r.id, templateTitle: r.title },
  );
}

/** "Create now": a card right away; the schedule is unchanged. Refuses while one is open unless forced. */
export function runTemplateNow(ctx: Ctx, id: number, force = false): CardDetail {
  const r = row(ctx, id);
  const open = openCardId(ctx, id);
  if (open !== null && !force) throw conflict('open_instance', 'A card from this template is still open', { cardId: open });
  const card = makeCard(ctx, r, today(ctx));
  ctx.s.templateRuns.push({ id: nextId(ctx, 'templateRuns'), templateId: id, occurrenceDate: null, outcome: 'manual', cardId: card.id, ranAt: nowIso(ctx) });
  return card;
}

/** Handles every enabled template that is due today (or overdue). Returns whether anything changed. */
export function runDueTemplates(ctx: Ctx): boolean {
  const day = today(ctx);
  let changed = false;
  for (const r of ctx.s.templates.filter((t) => t.enabled && t.nextRunDate <= day).sort((a, b) => a.id - b.id)) {
    changed = true;
    const schedule = scheduleOf(r);
    const occ = latestOnOrBefore(schedule, day) ?? r.nextRunDate;
    const claimed = !ctx.s.templateRuns.some((x) => x.templateId === r.id && x.occurrenceDate === occ);
    if (claimed) {
      const open = openCardId(ctx, r.id);
      const run = { id: nextId(ctx, 'templateRuns'), templateId: r.id, occurrenceDate: occ, ranAt: nowIso(ctx) };
      if (open !== null) {
        ctx.s.templateRuns.push({ ...run, outcome: 'skipped_open', cardId: open });
        recordEvent(ctx, open, 'recurrence_skipped', { templateId: r.id, templateTitle: r.title, occurrenceDate: occ });
      } else {
        const card = makeCard(ctx, r, occ);
        ctx.s.templateRuns.push({ ...run, outcome: 'created', cardId: card.id });
      }
    }
    r.nextRunDate = firstAfter(schedule, day);
  }
  return changed;
}

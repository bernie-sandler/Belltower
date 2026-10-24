// Card import: turn a JSON description of one or more cards (typically written by an AI from a
// problem description) into real cards. Forgiving on input, strict on output:
//  - accepts { "cards": [...] }, a bare array, or a single card object; ```json fences are stripped
//  - priority: P0–P3, critical/high/medium/low (or 0–3); severity: S1–S4, blocker/major/minor/trivial
//  - column and labels by name (case-insensitive); unknown labels are created, unknown columns fall
//    back to Triage with a warning
//  - due: "YYYY-MM-DD" or "YYYY-MM-DD HH:MM"; work-log times: local "YYYY-MM-DD HH:MM" or ISO
// A preview (dryRun) reports exactly what would be created, per card, before anything is saved.

import {
  LIMITS,
  type CardDetail,
  type Priority,
  type Severity,
} from '@tt/shared';
import { stmt } from '../db/connection';
import { badRequest } from '../errors';
import { zonedToInstant } from '../lib/tz';
import { createCard, FUTURE_SLACK_MS } from './cards';
import { tx, type Ctx } from './context';
import { addWorklog } from './worklog';

export const CARD_IMPORT_FORMAT = 'tower-tracker/cards@1';

export interface ImportCard {
  title: string;
  description: string;
  column: { id: number; name: string };
  labels: { name: string; existing: boolean }[];
  priority: Priority | null;
  severity: Severity | null;
  dueDate: string | null;
  dueTime: string | null;
  checklists: { title: string; items: string[] }[];
  worklog: { bodyMd: string; occurredAt: string | null }[];
}

export interface ImportItemResult {
  index: number;
  ok: boolean;
  card: ImportCard | null;
  errors: string[];
  warnings: string[];
}

export interface ImportResult {
  format: string;
  items: ImportItemResult[];
  /** Ids of created cards (empty for a preview or when nothing was valid). */
  created: number[];
}

const PRIORITY_ALIASES: Record<string, Priority> = {
  p0: 'critical', critical: 'critical', '0': 'critical', urgent: 'critical',
  p1: 'high', high: 'high', '1': 'high',
  p2: 'medium', medium: 'medium', normal: 'medium', '2': 'medium',
  p3: 'low', low: 'low', '3': 'low',
};
const SEVERITY_ALIASES: Record<string, Severity> = {
  s1: 'blocker', blocker: 'blocker', critical: 'blocker', '1': 'blocker',
  s2: 'major', major: 'major', '2': 'major',
  s3: 'minor', minor: 'minor', '3': 'minor',
  s4: 'trivial', trivial: 'trivial', cosmetic: 'trivial', '4': 'trivial',
};

/** Strips Markdown code fences and surrounding chatter an AI may add, then parses JSON. */
export function parseImportText(text: string): unknown {
  let t = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) t = fence[1]!.trim();
  else {
    // Prose around the JSON: take the outermost {...} or [...].
    const first = t.search(/[[{]/);
    const last = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (first > 0 && last > first) t = t.slice(first, last + 1);
  }
  try {
    return JSON.parse(t);
  } catch (err) {
    throw badRequest('validation', `That isn't valid JSON: ${(err as Error).message}`);
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : null);
const pick = (o: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};

function normalizeOne(ctx: Ctx, raw: unknown, index: number, columns: { id: number; name: string; role: string | null }[]): ImportItemResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { index, ok: false, card: null, errors: ['Each card must be an object'], warnings };
  }
  const o = raw as Record<string, unknown>;

  const title = str(pick(o, 'title', 'name', 'summary'));
  if (!title) errors.push('Missing "title"');
  else if (title.length > LIMITS.cardTitle) errors.push(`"title" is longer than ${LIMITS.cardTitle} characters`);

  const description = str(pick(o, 'description', 'body', 'details', 'notes_md')) ?? '';
  if (description.length > LIMITS.description) errors.push('"description" is too long');

  const triage = columns.find((c) => c.role === 'triage') ?? columns[0]!;
  let column = triage;
  const colName = str(pick(o, 'column', 'list', 'status', 'stage'));
  if (colName) {
    const found = columns.find((c) => c.name.toLowerCase() === colName.toLowerCase());
    if (found) column = found;
    else warnings.push(`Column "${colName}" doesn't exist; using ${triage.name}`);
  }

  const rawLabels = pick(o, 'labels', 'tags');
  const labelNames = (Array.isArray(rawLabels) ? rawLabels.map(str) : typeof rawLabels === 'string' ? rawLabels.split(',') : [])
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .map((s) => s.slice(0, LIMITS.labelName));
  const labels = [...new Map(labelNames.map((n) => [n.toLowerCase(), n])).values()].map((name) => {
    const existing = Boolean(stmt(ctx.db, 'SELECT 1 FROM labels WHERE name = ? COLLATE NOCASE').get(name));
    if (!existing) warnings.push(`New label "${name}" will be created`);
    return { name, existing };
  });

  let priority: Priority | null = null;
  const p = str(pick(o, 'priority'));
  if (p) {
    priority = PRIORITY_ALIASES[p.toLowerCase().split(/\s+/)[0]!] ?? null;
    if (!priority) errors.push(`Unknown priority "${p}" (use P0, P1, P2 or P3)`);
  }
  let severity: Severity | null = null;
  const s = str(pick(o, 'severity'));
  if (s) {
    severity = SEVERITY_ALIASES[s.toLowerCase().split(/\s+/)[0]!] ?? null;
    if (!severity) errors.push(`Unknown severity "${s}" (use S1, S2, S3 or S4)`);
  }

  let dueDate: string | null = null;
  let dueTime: string | null = null;
  const due = str(pick(o, 'due', 'dueDate', 'due_date'));
  if (due) {
    const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/.exec(due);
    if (!m || Number.isNaN(Date.parse(m[1]!))) errors.push(`"due" must look like 2026-10-30 or 2026-10-30 18:00 (got "${due}")`);
    else {
      dueDate = m[1]!;
      dueTime = m[2] ?? null;
    }
  }

  const checklists: ImportCard['checklists'] = [];
  const rawLists = pick(o, 'checklists');
  const rawSingle = pick(o, 'checklist', 'steps', 'tasks');
  const toItems = (v: unknown) =>
    (Array.isArray(v) ? v : [])
      .map((x) => (typeof x === 'object' && x ? str((x as Record<string, unknown>).text) : str(x)))
      .filter((x): x is string => Boolean(x))
      .map((x) => x.slice(0, LIMITS.checklistItem));
  if (Array.isArray(rawLists)) {
    rawLists.forEach((l, i) => {
      if (l && typeof l === 'object' && !Array.isArray(l)) {
        const lo = l as Record<string, unknown>;
        const items = toItems(pick(lo, 'items', 'steps'));
        if (items.length) checklists.push({ title: (str(lo.title) || `Checklist ${i + 1}`).slice(0, LIMITS.checklistTitle), items });
      } else if (typeof l === 'string') {
        // A flat list of strings given as "checklists".
        const last = checklists[0] ?? (checklists.push({ title: 'Checklist', items: [] }), checklists[0]!);
        last.items.push(l.slice(0, LIMITS.checklistItem));
      }
    });
  }
  if (rawSingle !== undefined) {
    const items = toItems(rawSingle);
    if (items.length) checklists.push({ title: 'Checklist', items });
  }

  const worklog: ImportCard['worklog'] = [];
  const rawLog = pick(o, 'worklog', 'workLog', 'log', 'notes');
  for (const entry of Array.isArray(rawLog) ? rawLog : rawLog ? [rawLog] : []) {
    const e = typeof entry === 'string' ? { text: entry } : (entry as Record<string, unknown>);
    const text = str(pick(e ?? {}, 'text', 'body', 'note'));
    if (!text) continue;
    const at = str(pick(e ?? {}, 'at', 'when', 'time', 'occurredAt'));
    let occurredAt: string | null = null;
    if (at) {
      const local = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/.exec(at);
      const t = local ? zonedToInstant(local[1]!, local[2]!, ctx.tz).getTime() : Date.parse(at);
      if (Number.isNaN(t)) errors.push(`Work-log time "${at}" isn't a date/time`);
      else if (t > ctx.clock.now().getTime() + FUTURE_SLACK_MS) errors.push(`Work-log time "${at}" is in the future`);
      else occurredAt = new Date(t).toISOString();
    }
    worklog.push({ bodyMd: text.slice(0, LIMITS.worklog), occurredAt });
  }

  const card: ImportCard | null = title
    ? { title, description, column, labels, priority, severity, dueDate, dueTime, checklists, worklog }
    : null;
  return { index, ok: errors.length === 0 && card !== null, card, errors, warnings };
}

/** Validates (and, unless dryRun, creates) the cards. All-or-nothing: nothing is created if any card has errors. */
export function importCards(ctx: Ctx, input: unknown, dryRun: boolean): ImportResult {
  const data = typeof input === 'string' ? parseImportText(input) : input;
  let list: unknown[];
  if (Array.isArray(data)) list = data;
  else if (data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).cards)) {
    list = (data as Record<string, unknown>).cards as unknown[];
  } else if (data && typeof data === 'object') list = [data];
  else throw badRequest('validation', 'Expected a card, a list of cards, or { "cards": [...] }');
  if (!list.length) throw badRequest('validation', 'No cards found');
  if (list.length > 200) throw badRequest('validation', 'Import at most 200 cards at a time');

  const columns = stmt(ctx.db, 'SELECT id, name, role FROM columns ORDER BY position, id').all() as {
    id: number;
    name: string;
    role: string | null;
  }[];
  const items = list.map((raw, i) => normalizeOne(ctx, raw, i, columns));
  const result: ImportResult = { format: CARD_IMPORT_FORMAT, items, created: [] };
  if (dryRun || items.some((i) => !i.ok)) return result;

  tx(ctx, () => {
    for (const item of items) {
      const c = item.card!;
      const detail: CardDetail = createCard(
        ctx,
        {
          title: c.title,
          description: c.description,
          columnId: c.column.id,
          labelNames: c.labels.map((l) => l.name),
          priority: c.priority,
          severity: c.severity,
          dueDate: c.dueDate,
          dueTime: c.dueTime,
          checklists: c.checklists,
        },
        { source: 'api', via: 'card import' },
      );
      for (const w of c.worklog) addWorklog(ctx, detail.id, { bodyMd: w.bodyMd, ...(w.occurredAt ? { occurredAt: w.occurredAt } : {}) });
      result.created.push(detail.id);
    }
  });
  return result;
}

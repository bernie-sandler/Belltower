// Mirrors server/src/services/cardImport.ts: the AI-friendly card import format
// (docs/CARD-IMPORT.md), checked and created entirely in the browser.

import { LIMITS, type CardKind, type ImportPreview, type ImportPreviewItem, type LinkDirection, type Priority, type Severity } from '@tt/shared';
import { createCard, FUTURE_SLACK_MS, resolveCard } from './cards';
import { getBlockedColumnId } from './columns';
import type { Ctx } from './db';
import { badRequest } from './errors';
import { zonedToInstant } from './lib';
import { createLink } from './links';
import { getResolutionReasons } from './settings';
import { addWorklog } from './worklog';

export const CARD_IMPORT_FORMAT = 'belltower/cards@1';

type ImportCard = NonNullable<ImportPreviewItem['card']> & { ref: string | null };
type ImportParent = NonNullable<ImportCard['parent']>;

interface ImportItem extends Omit<ImportPreviewItem, 'card'> {
  card: ImportCard | null;
}

interface Pending extends ImportItem {
  partOf: string | null;
  nestedUnder: number | null;
  linkRefs: { direction: LinkDirection; ref: string; field: string }[];
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

const LINK_FIELDS: [LinkDirection, string, string[]][] = [
  ['blocks', 'blocks', ['blocks']],
  ['blocked_by', 'blockedBy', ['blockedBy', 'blocked_by', 'dependsOn', 'depends_on', 'waitingOn', 'waiting_on']],
  ['relates', 'relatedTo', ['relatedTo', 'related_to', 'related', 'relates']],
];

/** Strips Markdown code fences and surrounding chatter an AI may add, then parses JSON. */
export function parseImportText(text: string): unknown {
  let t = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) t = fence[1]!.trim();
  else {
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

type ColumnInfo = { id: number; name: string; role: string | null };

function normalizeOne(ctx: Ctx, raw: unknown, index: number, label: string, columns: ColumnInfo[], defaultColumn: ColumnInfo | null): Pending {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { index, label, ok: false, card: null, errors: ['Each card must be an object'], warnings, partOf: null, nestedUnder: null, linkRefs: [] };
  }
  const o = raw as Record<string, unknown>;

  const rawKind = str(pick(o, 'type', 'kind'))?.toLowerCase() ?? null;
  const hasNested = Array.isArray(o.tickets);
  let kind: CardKind = hasNested ? 'work' : 'ticket';
  if (rawKind) {
    if (rawKind === 'work' || rawKind === 'work card') kind = 'work';
    else if (rawKind === 'ticket' || rawKind === 'issue') kind = 'ticket';
    else errors.push(`Unknown type "${rawKind}" (use "work" or "ticket")`);
  }
  if (hasNested && kind !== 'work') errors.push('Only a work card ("type": "work") can have "tickets"');
  const ref = str(pick(o, 'ref', 'id', 'key'));
  const partOf = str(pick(o, 'partOf', 'part_of', 'parent'));
  if (partOf && kind === 'work') errors.push(`A work card can't be "partOf" another card`);

  const linkRefs: Pending['linkRefs'] = [];
  for (const [direction, field, keys] of LINK_FIELDS) {
    const v = pick(o, ...keys);
    if (v === undefined) continue;
    for (const x of Array.isArray(v) ? v : [v]) {
      const r = str(x);
      if (r) linkRefs.push({ direction, ref: r, field });
      else errors.push(`"${field}" must list ticket numbers or refs (got ${JSON.stringify(x)})`);
    }
  }
  if (linkRefs.length > 50) errors.push('At most 50 links per card');

  const title = str(pick(o, 'title', 'name', 'summary'));
  if (!title) errors.push('Missing "title"');
  else if (title.length > LIMITS.cardTitle) errors.push(`"title" is longer than ${LIMITS.cardTitle} characters`);

  const description = str(pick(o, 'description', 'body', 'details', 'notes_md')) ?? '';
  if (description.length > LIMITS.description) errors.push('"description" is too long');

  const triage = columns.find((c) => c.role === 'triage') ?? columns[0]!;
  let column = defaultColumn ?? triage;
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
    const existing = ctx.s.labels.some((l) => l.name.toLowerCase() === name.toLowerCase());
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
      else if (t > ctx.now().getTime() + FUTURE_SLACK_MS) errors.push(`Work-log time "${at}" is in the future`);
      else occurredAt = new Date(t).toISOString();
    }
    worklog.push({ bodyMd: text.slice(0, LIMITS.worklog), occurredAt });
  }

  let resolution: ImportCard['resolution'] = null;
  const rawRes = pick(o, 'resolution');
  const resObj = rawRes && typeof rawRes === 'object' && !Array.isArray(rawRes) ? (rawRes as Record<string, unknown>) : null;
  const reason = resObj ? str(pick(resObj, 'reason')) : str(rawRes);
  const resNote = (resObj ? str(pick(resObj, 'note')) : null) ?? str(pick(o, 'resolutionNote', 'resolution_note')) ?? '';
  if (reason || resNote) {
    const known = getResolutionReasons(ctx);
    const r = reason ?? known[0]!;
    if (r.length > 40) errors.push('"resolution" must be at most 40 characters');
    else if (resNote.length > LIMITS.description) errors.push('"resolutionNote" is too long');
    else if (column.role !== 'done') warnings.push(`"resolution" is only kept for cards in ${columns.find((c) => c.role === 'done')?.name ?? 'Done'}; ignored`);
    else {
      const match = known.find((k) => k.toLowerCase() === r.toLowerCase());
      if (!match) warnings.push(`Resolution "${r}" isn't in your list of reasons; kept as written`);
      resolution = { reason: match ?? r, note: resNote };
    }
  }

  const card: ImportCard | null = title
    ? { kind, ref, parent: null, links: [], title, description, column: { id: column.id, name: column.name }, labels, priority, severity, dueDate, dueTime, checklists, worklog, resolution }
    : null;
  return { index, label, ok: errors.length === 0 && card !== null, card, errors, warnings, partOf, nestedUnder: null, linkRefs };
}

function flatten(ctx: Ctx, list: unknown[], columns: ColumnInfo[]): Pending[] {
  const out: Pending[] = [];
  list.forEach((raw, i) => {
    const parent = normalizeOne(ctx, raw, out.length, String(i + 1), columns, null);
    const parentIndex = out.length;
    out.push(parent);
    const nested = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).tickets : undefined;
    if (!Array.isArray(nested)) return;
    nested.forEach((childRaw, j) => {
      const child = normalizeOne(ctx, childRaw, out.length, `${i + 1}.${j + 1}`, columns, columns.find((c) => c.id === parent.card?.column.id) ?? null);
      child.nestedUnder = parentIndex;
      if (childRaw && typeof childRaw === 'object' && Array.isArray((childRaw as Record<string, unknown>).tickets)) {
        child.errors.push('Tickets can only be nested one level deep');
      }
      if (child.card?.kind === 'work') child.errors.push("A work card can't be nested inside another work card");
      if (child.partOf) child.errors.push('A nested ticket already belongs to the work card above it; remove "partOf"');
      out.push(child);
    });
  });
  return out;
}

function resolveRelations(ctx: Ctx, items: Pending[], columns: ColumnInfo[]): void {
  const byRef = new Map<string, Pending>();
  const byTitle = new Map<string, Pending[]>();
  for (const it of items) {
    if (!it.card) continue;
    if (it.card.ref) {
      const key = it.card.ref.toLowerCase();
      if (byRef.has(key)) it.errors.push(`Another card already uses "ref": "${it.card.ref}"`);
      byRef.set(key, it);
    }
    const t = it.card.title.toLowerCase();
    byTitle.set(t, [...(byTitle.get(t) ?? []), it]);
  }
  const inBatch = (ref: string, onlyWork = false): Pending | undefined => {
    const key = ref.toLowerCase();
    const r = byRef.get(key);
    if (r) return r;
    const titled = (byTitle.get(key) ?? []).filter((p) => !onlyWork || p.card?.kind === 'work');
    return titled.length === 1 ? titled[0] : undefined;
  };
  const onBoard = (ticketNo: string) => ctx.s.cards.find((c) => c.ticketNo === ticketNo && !c.deletedAt);

  for (const it of items) {
    if (!it.card) continue;
    if (it.nestedUnder !== null) {
      const p = items[it.nestedUnder]!;
      if (p.card) it.card.parent = { batchIndex: p.index, title: p.card.title };
    } else if (it.partOf) {
      const found = inBatch(it.partOf, true) ?? inBatch(it.partOf);
      if (found?.card) {
        if (found.card.kind !== 'work') it.errors.push(`"partOf": "${it.partOf}" is a ticket, not a work card`);
        else it.card.parent = { batchIndex: found.index, title: found.card.title };
      } else {
        const existing = onBoard(it.partOf);
        if (!existing) it.errors.push(`"partOf": "${it.partOf}" isn't a work card in this import or a ticket number on the board`);
        else if (existing.kind !== 'work') it.errors.push(`"partOf": ${it.partOf} is a ticket, not a work card`);
        else it.card.parent = { id: existing.id, ticketNo: existing.ticketNo, title: existing.title };
      }
    }
  }

  const doneColumns = new Set(columns.filter((c) => c.role === 'done').map((c) => c.id));
  const blockedColumnId = getBlockedColumnId(ctx);
  const blockedColumn = columns.find((c) => c.id === blockedColumnId);
  type End = { key: string; title: string; done: boolean; pending?: Pending };
  const edges = new Set<string>();
  const seenBlocked = new Set<number>();
  for (const it of items) {
    if (!it.card) continue;
    const self: End = { key: `b${it.index}`, title: it.card.title, done: doneColumns.has(it.card.column.id), pending: it };
    for (const { direction, ref, field } of it.linkRefs) {
      let other: End;
      let target: ImportParent;
      const found = inBatch(ref);
      if (found?.card) {
        if (found === it) {
          it.errors.push(`"${field}": a card can't be linked to itself`);
          continue;
        }
        other = { key: `b${found.index}`, title: found.card.title, done: doneColumns.has(found.card.column.id), pending: found };
        target = { batchIndex: found.index, title: found.card.title };
      } else {
        const existing = onBoard(ref);
        if (!existing) {
          it.errors.push(`"${field}": "${ref}" isn't a card in this import or a ticket number on the board`);
          continue;
        }
        other = { key: `e${existing.id}`, title: existing.title, done: existing.completedAt !== null };
        target = { id: existing.id, ticketNo: existing.ticketNo, title: existing.title };
      }

      const [blocker, blocked] = direction === 'blocks' ? [self, other] : [other, self];
      const key = direction === 'relates' ? `r:${[self.key, other.key].sort().join('|')}` : `k:${blocker.key}>${blocked.key}`;
      if (edges.has(key)) continue;
      if (direction !== 'relates' && edges.has(`k:${blocked.key}>${blocker.key}`)) {
        it.errors.push(`"${field}": “${self.title}” and “${other.title}” can't block each other`);
        continue;
      }
      if (direction !== 'relates' && blocked.done && !blocker.done) {
        it.errors.push(`"${field}": “${blocked.title}” is done, so the open card “${blocker.title}” can't block it`);
        continue;
      }
      edges.add(key);
      it.card.links.push({ direction, target });

      const bp = blocked.pending;
      if (direction !== 'relates' && !blocker.done && bp?.card && !seenBlocked.has(bp.index)) {
        seenBlocked.add(bp.index);
        if (blockedColumn && bp.card.column.id !== blockedColumn.id && !doneColumns.has(bp.card.column.id)) {
          bp.warnings.push(`Blocked by an open card, so it will go to ${blockedColumn.name}`);
        }
      }
    }
  }
  for (const it of items) it.ok = it.errors.length === 0 && it.card !== null;
}

/** Parses and checks cards in the import format (nothing is saved). */
export function prepareImport(ctx: Ctx, input: unknown): ImportItem[] {
  const data = typeof input === 'string' ? parseImportText(input) : input;
  let list: unknown[];
  if (Array.isArray(data)) list = data;
  else if (data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).cards)) {
    list = (data as Record<string, unknown>).cards as unknown[];
  } else if (data && typeof data === 'object') list = [data];
  else throw badRequest('validation', 'Expected a card, a list of cards, or { "cards": [...] }');
  if (!list.length) throw badRequest('validation', 'No cards found');
  if (list.length > 200) throw badRequest('validation', 'Import at most 200 cards at a time');

  const columns = [...ctx.s.columns].sort((a, b) => a.position - b.position || a.id - b.id).map((c) => ({ id: c.id, name: c.name, role: c.role }));
  const pending = flatten(ctx, list, columns);
  if (pending.length > 200) throw badRequest('validation', 'Import at most 200 cards at a time (including nested tickets)');
  resolveRelations(ctx, pending, columns);
  return pending.map(({ partOf: _p, nestedUnder: _n, linkRefs: _l, ...item }) => item);
}

/** Creates checked cards (every item must be ok). Returns their ids in the batch order. */
export function createImported(ctx: Ctx, items: ImportItem[], opts: { via: string }): number[] {
  const createdIds = new Map<number, number>();
  const order = [...items.filter((i) => i.card!.kind === 'work'), ...items.filter((i) => i.card!.kind !== 'work')];
  for (const item of order) {
    const c = item.card!;
    const parentId = c.parent ? ('batchIndex' in c.parent ? createdIds.get(c.parent.batchIndex)! : c.parent.id) : null;
    const detail = createCard(
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
        kind: c.kind,
        parentId,
      },
      { source: 'api', via: opts.via },
    );
    for (const w of c.worklog) addWorklog(ctx, detail.id, { bodyMd: w.bodyMd, ...(w.occurredAt ? { occurredAt: w.occurredAt } : {}) }, { quiet: true });
    if (c.resolution) resolveCard(ctx, detail.id, c.resolution);
    createdIds.set(item.index, detail.id);
  }
  for (const item of items) {
    const from = createdIds.get(item.index)!;
    for (const l of item.card!.links) {
      createLink(ctx, from, 'batchIndex' in l.target ? createdIds.get(l.target.batchIndex)! : l.target.id, l.direction);
    }
  }
  return items.map((i) => createdIds.get(i.index)!);
}

/** Validates (and, unless dryRun, creates) the cards. All or nothing. */
export function importCards(ctx: Ctx, input: unknown, dryRun: boolean): ImportPreview & { format: string } {
  const items = prepareImport(ctx, input);
  // The preview type the web app reads has no "ref"; the server sends it anyway, and so does the demo.
  const result = { format: CARD_IMPORT_FORMAT, items: items as ImportPreviewItem[], created: [] as number[] };
  if (dryRun || items.some((i) => !i.ok)) return result;
  result.created = createImported(ctx, items, { via: 'card import' });
  return result;
}

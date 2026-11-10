// Human-readable lines for activity entries. `data` shapes are documented in shared/src/types.ts;
// names are copied into each entry, so history reads correctly after renames and deletes.
// Everything is read defensively: unknown or future shapes fall back to a generic line.
// Who did it is a separate line (activityActor), so every event type gets it without its own wording.

import { PRIORITY_LABELS, SEVERITY_LABELS, type ActivityEntry, type Priority, type Severity } from '@tt/shared';
import { formatClock, formatDateTime, formatLocalDate } from '../../lib/time';

type Data = Record<string, unknown>;

function obj(v: unknown): Data | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Data) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function nameOf(v: unknown): string {
  return str(obj(v)?.name) ?? 'a column';
}

function names(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => str(obj(x)?.name)).filter((x): x is string => x !== null) : [];
}

function quoted(s: string | null, max = 60): string {
  if (s === null) return '…';
  const t = s.length > max ? `${s.slice(0, max - 1)}…` : s;
  return `‘${t}’`;
}

function priorityName(v: unknown): string | null {
  return typeof v === 'string' && v in PRIORITY_LABELS ? PRIORITY_LABELS[v as Priority] : null;
}

function dueText(v: unknown): string | null {
  const d = obj(v);
  const date = str(d?.date);
  if (!date) return null;
  const time = str(d?.time);
  return time ? `${formatLocalDate(date)}, ${formatClock(time)}` : formatLocalDate(date);
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function humanize(type: string): string {
  const s = type.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Who did it, shown beside the entry: "Alice", "via API token “Kuma” (Alice)", and for a new card
 * how it came in: "submit page (Sam)", "card import", "recurring", "Alice via Add ticket". Null
 * when nobody is known: entries from before 1.5, and startup or timer steps.
 */
export function activityActor(entry: ActivityEntry): string | null {
  const person = entry.userId !== null ? str(entry.userName) : null;
  const token = entry.tokenId !== null ? `API token “${str(entry.tokenName) ?? '…'}”${person ? ` (${person})` : ''}` : null;
  // How a card arrived. A token's own name is already in `token`; a recurring run says so only
  // when no person started it ("Create now" is a person's).
  let how: string | null = null;
  if (entry.type === 'created') {
    const via = str(entry.data?.via)?.trim() || null;
    if (via) how = token && via.startsWith('API token') ? null : via;
    else if (entry.data?.source === 'recurring' && !person && !token) how = 'recurring';
  }
  if (token) return how ? `via ${token}, ${how}` : `via ${token}`;
  if (person) return how ? `${person} via ${how}` : person;
  return how;
}

export function activityText(entry: ActivityEntry): string {
  const d = entry.data ?? {};
  switch (entry.type) {
    case 'created': {
      const column = nameOf(d.column);
      const template = str(d.templateTitle);
      const what = d.kind === 'work' ? 'Created as a work card' : 'Created';
      const parent = d.parent as { ticketNo?: unknown; title?: unknown } | undefined;
      const under = parent
        ? `, filed under ${quoted(`${typeof parent.ticketNo === 'string' ? `${parent.ticketNo} — ` : ''}${str(parent.title) ?? ''}`)}`
        : '';
      return template ? `${what} in ${column} from template ${quoted(template)}${under}` : `${what} in ${column}${under}`;
    }
    case 'moved': {
      const base = `Moved from ${nameOf(d.from)} → ${nameOf(d.to)}`;
      if (d.reason === 'column_deleted') return `${base} (the column was deleted)`;
      if (d.reason === 'blocked') {
        const by = Array.isArray(d.blockedBy) ? d.blockedBy.map((b) => quoted(str((b as { title?: unknown }).title))) : [];
        return by.length ? `${base}: blocked by ${by.join(', ')}` : `${base}: blocked`;
      }
      return base;
    }
    case 'kind_changed':
      return d.to === 'work' ? 'Made a work card' : 'Made a ticket';
    case 'parent_changed': {
      const ref = (v: unknown) => {
        const r = v as { ticketNo?: unknown; title?: unknown } | null;
        return r ? quoted(`${typeof r.ticketNo === 'string' ? `${r.ticketNo} — ` : ''}${str(r.title) ?? ''}`) : null;
      };
      const from = ref(d.from);
      const to = ref(d.to);
      return to ? (from ? `Moved from work card ${from} to ${to}` : `Filed under work card ${to}`) : `Taken out of work card ${from ?? ''}`;
    }
    case 'child_added':
    case 'child_removed': {
      const c = d.child as { ticketNo?: unknown; title?: unknown } | undefined;
      const name = quoted(`${typeof c?.ticketNo === 'string' ? `${c.ticketNo} — ` : ''}${str(c?.title) ?? ''}`);
      return entry.type === 'child_added' ? `Ticket ${name} filed here` : `Ticket ${name} taken out`;
    }
    case 'resolved': {
      const reason = str(d.reason);
      if (!reason) return 'Resolution cleared';
      const note = str(d.note)?.trim();
      const verb = str(d.from) ? 'Resolution changed to' : 'Resolved:';
      return note ? `${verb} ${reason} — ${quoted(note, 80)}` : `${verb} ${reason}`;
    }
    case 'assigned': {
      // Names are copied in as they were then; whoever made the change is the entry's userId.
      const to = typeof d.to === 'number' ? d.to : null;
      if (to === null) return typeof d.from === 'number' ? `Unassigned ${str(d.fromName) ?? 'someone'}` : 'Unassigned';
      if (entry.userId !== null && to === entry.userId) return 'Took this';
      return `Assigned this to ${str(d.toName) ?? 'someone'}`;
    }
    case 'title_changed':
      return `Renamed from ${quoted(str(d.from))} to ${quoted(str(d.to))}`;
    case 'description_changed': {
      const from = str(d.from) ?? '';
      const to = str(d.to) ?? '';
      if (!from.trim() && to.trim()) return 'Description added';
      if (from.trim() && !to.trim()) return 'Description removed';
      return 'Description edited';
    }
    case 'labels_changed': {
      const added = names(d.added);
      const removed = names(d.removed);
      if (d.reason === 'label_deleted' && removed.length) {
        return `Label ${list(removed)} was deleted`;
      }
      const parts: string[] = [];
      if (added.length) parts.push(`Added label${added.length > 1 ? 's' : ''} ${list(added)}`);
      if (removed.length) {
        const text = `removed label${removed.length > 1 ? 's' : ''} ${list(removed)}`;
        parts.push(parts.length ? text : text.charAt(0).toUpperCase() + text.slice(1));
      }
      return parts.length ? parts.join('; ') : 'Labels changed';
    }
    case 'priority_changed': {
      const to = priorityName(d.to);
      return to ? `Priority set to ${to}` : 'Priority cleared';
    }
    case 'severity_changed': {
      const to = typeof d.to === 'string' && d.to in SEVERITY_LABELS ? SEVERITY_LABELS[d.to as Severity] : null;
      return to ? `Severity set to ${to}` : 'Severity cleared';
    }
    case 'due_changed': {
      const from = dueText(d.from);
      const to = dueText(d.to);
      if (!to) return 'Due date removed';
      return from ? `Due date changed to ${to}` : `Due date set to ${to}`;
    }
    case 'completion_changed': {
      const to = str(d.to);
      return to ? `Completed on ${formatDateTime(to)}` : 'Marked not completed';
    }
    case 'checklist_added':
      return `Added checklist ${quoted(str(d.title))}`;
    case 'checklist_removed':
      return `Removed checklist ${quoted(str(d.title))}`;
    case 'checklist_item_checked':
      return `Checked ${quoted(str(d.text) ?? str(d.title))}`;
    case 'checklist_item_unchecked':
      return `Unchecked ${quoted(str(d.text) ?? str(d.title))}`;
    case 'checklist_item_marked': {
      const what = quoted(str(d.text) ?? str(d.title));
      return d.state === 'failed' || d.state === 'unverified' ? `Marked ${what} ${d.state}` : `Marked ${what}`;
    }
    case 'attachment_added':
      return `Attached ${quoted(str(d.name) ?? str(d.filename))}`;
    case 'attachment_removed':
      return `Removed attachment ${quoted(str(d.name) ?? str(d.filename))}`;
    case 'linked':
    case 'unlinked': {
      const other = quoted(str(d.otherTitle) ?? str(d.title) ?? str(obj(d.card)?.title));
      const verb = entry.type === 'linked' ? 'Linked' : 'Unlinked';
      if (d.direction === 'blocks') return `${verb}: this card blocks ${other}`;
      if (d.direction === 'blocked_by') return `${verb}: this card is blocked by ${other}`;
      return entry.type === 'linked' ? `Linked as related to ${other}` : `Unlinked from ${other}`;
    }
    case 'archived':
      return 'Archived';
    case 'restored':
      return 'Restored from the archive';
    case 'deleted':
      return 'Moved to Trash';
    case 'undeleted':
      return 'Restored from Trash';
    case 'recurrence_skipped':
      return 'Recurring run skipped: this card was still open';
    case 'worklog_retracted':
    case 'worklog_restored': {
      const verb = entry.type === 'worklog_retracted' ? 'Retracted' : 'Restored';
      const text = str(d.text);
      return text ? `${verb} the work-log note ${quoted(text)}` : `${verb} a work-log note`;
    }
    case 'worklog':
      return 'Logged work';
    default:
      return humanize(String(entry.type));
  }
}

// The editable fields of a new ticket, prefilled from a Claude draft or empty.

import {
  LIMITS,
  type CardKind,
  type CardTile,
  type Column,
  type CreateTicketBody,
  type DraftCardRef,
  type Label,
  type LinkDirection,
  type Priority,
  type Severity,
  type TicketDraft,
} from '@tt/shared';
import { CalendarDays, Columns3, Flag, FolderInput, FolderOpen, Link2, ListChecks, OctagonAlert, Plus, Tag, X } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { sortedColumns } from '../../api/board';
import { sortedLabels } from '../../api/labels';
import { AutoGrowTextarea } from '../common/AutoGrowTextarea';
import { Markdown } from '../common/Markdown';
import { PriorityHelper } from '../card/CardFields';
import { LevelPicker } from '../card/LevelPicker';
import { PRIORITY_OPTIONS, SEVERITY_OPTIONS } from '../card/levelOptions';
import { TicketTitle } from '../common/TicketTitle';
import { LabelChip } from '../labels/LabelChip';
import { SimilarHints } from './SimilarHints';

export interface TicketFields {
  title: string;
  description: string;
  /** null = the Triage column. */
  columnId: number | null;
  priority: Priority | null;
  severity: Severity | null;
  labelIds: number[];
  dueDate: string;
  checklist: string[];
  kind: CardKind;
  /** The work card a ticket is filed under. */
  parentId: number | null;
  /** Links to existing cards (Claude's suggestions; more can be added on the card afterwards). */
  links: { direction: LinkDirection; card: DraftCardRef }[];
}

export const LINK_WORDS: Record<LinkDirection, string> = {
  blocks: 'Blocks',
  blocked_by: 'Blocked by',
  relates: 'Related to',
};

export const emptyTicket = (): TicketFields => ({
  title: '',
  description: '',
  columnId: null,
  priority: null,
  severity: null,
  labelIds: [],
  dueDate: '',
  checklist: [],
  kind: 'ticket',
  parentId: null,
  links: [],
});

export const fromDraft = (d: TicketDraft): TicketFields => ({
  title: d.title,
  description: d.description,
  columnId: null,
  priority: d.priority,
  severity: d.severity,
  labelIds: d.labelIds,
  dueDate: d.dueDate ?? '',
  checklist: d.checklist,
  kind: d.kind,
  parentId: d.kind === 'ticket' ? (d.parent?.id ?? null) : null,
  links: d.links.map((l) => ({ direction: l.direction, card: l.card })),
});

export function toCreateBody(f: TicketFields, aiDrafted: boolean): CreateTicketBody {
  const checklist = f.checklist.map((s) => s.trim()).filter(Boolean);
  return {
    title: f.title.trim(),
    description: f.description,
    ...(f.columnId !== null ? { columnId: f.columnId } : {}),
    priority: f.priority,
    severity: f.severity,
    labelIds: f.labelIds,
    dueDate: f.dueDate || null,
    ...(checklist.length ? { checklist } : {}),
    kind: f.kind,
    ...(f.kind === 'ticket' && f.parentId !== null ? { parentId: f.parentId } : {}),
    ...(f.links.length ? { links: f.links.map((l) => ({ direction: l.direction, cardId: l.card.id })) } : {}),
    aiDrafted,
  };
}

interface Props {
  fields: TicketFields;
  onChange: (f: TicketFields) => void;
  /** The Claude draft these fields started from, for its reasoning. */
  suggestion: TicketDraft | null;
  columns: Column[];
  labels: Label[];
  /** Work cards on the board, for "Part of". */
  workCards: CardTile[];
  /** Ctrl/⌘+Enter in a text field. */
  onSubmit: () => void;
}

export function TicketForm({ fields, onChange, suggestion, columns, labels, workCards, onSubmit }: Props) {
  const id = useId();
  const [preview, setPreview] = useState(false);
  // The checklist row to focus as soon as it's rendered (a frame later would drop the first keys typed).
  const focusRow = useRef<number | null>(null);
  const set = <K extends keyof TicketFields>(key: K, value: TicketFields[K]) => onChange({ ...fields, [key]: value });
  const submitOnCtrlEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onSubmit();
    }
  };
  const triage = columns.find((c) => c.role === 'triage');

  /** Inserts an empty checklist row at `at` and focuses it once it renders. */
  function insertItem(at: number) {
    const next = [...fields.checklist];
    next.splice(at, 0, '');
    set('checklist', next);
    focusRow.current = at;
  }

  return (
    <div className="ticket-form">
      <div className="field-row">
        <div className="segmented" role="radiogroup" aria-label="Card type">
          {(
            [
              ['ticket', 'Ticket'],
              ['work', 'Work card'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={fields.kind === value}
              className="segmented-item"
              onClick={() => onChange({ ...fields, kind: value, parentId: value === 'work' ? null : fields.parentId })}
            >
              {value === 'work' && <FolderOpen size={14} aria-hidden />} {label}
            </button>
          ))}
        </div>
        {fields.kind === 'ticket' && (
          <label className="field-inline">
            <span className="field-inline-label">
              <FolderInput size={14} aria-hidden /> Part of
            </span>
            <select
              className="input select"
              value={fields.parentId ?? ''}
              onChange={(e) => set('parentId', e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">No work card</option>
              {workCards.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.ticketNo ? `${w.ticketNo} — ` : ''}
                  {w.title}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <label className="field">
        <span className="field-label">Title</span>
        <input
          className="input"
          value={fields.title}
          maxLength={LIMITS.cardTitle}
          onChange={(e) => set('title', e.target.value)}
          onKeyDown={submitOnCtrlEnter}
          placeholder="Short summary of the problem"
        />
      </label>
      {fields.kind === 'ticket' && <SimilarHints title={fields.title} description={fields.description} />}

      <div className="field-row ticket-levels">
        <div className="field-inline">
          <span className="field-inline-label" id={`${id}-prio`}>
            <Flag size={14} aria-hidden /> Priority
          </span>
          <LevelPicker labelledBy={`${id}-prio`} value={fields.priority} options={PRIORITY_OPTIONS} onChange={(v) => set('priority', v)} />
          <PriorityHelper value={fields.priority} onPick={(p) => set('priority', p)} />
        </div>
        <div className="field-inline">
          <span className="field-inline-label" id={`${id}-sev`}>
            <OctagonAlert size={14} aria-hidden /> Severity
          </span>
          <LevelPicker labelledBy={`${id}-sev`} value={fields.severity} options={SEVERITY_OPTIONS} onChange={(v) => set('severity', v)} />
        </div>
      </div>
      {suggestion && (
        <ul className="ticket-reasons muted small">
          <li>
            <strong>Priority:</strong> impact {suggestion.impact}, urgency {suggestion.urgency}. {suggestion.priorityReason}
          </li>
          <li>
            <strong>Severity:</strong> {suggestion.severityReason}
          </li>
          {suggestion.kind === 'work' && suggestion.kindReason && (
            <li>
              <strong>Work card:</strong> {suggestion.kindReason}
            </li>
          )}
          {suggestion.parent && (
            <li>
              <strong>Part of:</strong> <TicketTitle ticketNo={suggestion.parent.ticketNo}>{suggestion.parent.title}</TicketTitle>
            </li>
          )}
          {suggestion.links.map((l) => (
            <li key={l.card.id}>
              <strong>{LINK_WORDS[l.direction]}:</strong> <TicketTitle ticketNo={l.card.ticketNo}>{l.card.title}</TicketTitle>. {l.reason}
            </li>
          ))}
        </ul>
      )}

      {fields.links.length > 0 && (
        <fieldset className="ticket-fieldset">
          <legend className="field-inline-label">
            <Link2 size={14} aria-hidden /> Linked cards
          </legend>
          <ul className="ticket-links">
            {fields.links.map((l) => (
              <li key={l.card.id}>
                <span className="muted">{LINK_WORDS[l.direction]}</span>{' '}
                <TicketTitle ticketNo={l.card.ticketNo}>{l.card.title}</TicketTitle>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remove link to ${l.card.title}`}
                  onClick={() => set('links', fields.links.filter((x) => x.card.id !== l.card.id))}
                >
                  <X size={16} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </fieldset>
      )}

      <div className="field-row">
        <label className="field-inline">
          <span className="field-inline-label">
            <Columns3 size={14} aria-hidden /> Column
          </span>
          <select
            className="input select"
            value={fields.columnId ?? ''}
            onChange={(e) => set('columnId', e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">{triage ? `${triage.name} (default)` : 'Default'}</option>
            {sortedColumns(columns)
              .filter((c) => c.id !== triage?.id)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </label>
        <label className="field-inline">
          <span className="field-inline-label">
            <CalendarDays size={14} aria-hidden /> Due
          </span>
          <input className="input" type="date" value={fields.dueDate} onChange={(e) => set('dueDate', e.target.value)} />
          {fields.dueDate && (
            <button type="button" className="icon-btn" aria-label="Clear due date" onClick={() => set('dueDate', '')}>
              <X size={16} aria-hidden />
            </button>
          )}
        </label>
      </div>

      {labels.length > 0 && (
        <fieldset className="ticket-fieldset">
          <legend className="field-inline-label">
            <Tag size={14} aria-hidden /> Labels
          </legend>
          <div className="ticket-labels">
            {sortedLabels(labels).map((l) => {
              const on = fields.labelIds.includes(l.id);
              return (
                <button
                  key={l.id}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  aria-label={l.name}
                  className="ticket-label-toggle"
                  onClick={() => set('labelIds', on ? fields.labelIds.filter((x) => x !== l.id) : [...fields.labelIds, l.id])}
                >
                  <LabelChip label={l} />
                </button>
              );
            })}
          </div>
        </fieldset>
      )}

      <div className="field">
        <div className="editor-tabs" role="tablist" aria-label="Description editor">
          <span className="field-label">Description</span>
          <button type="button" role="tab" aria-selected={!preview} className="editor-tab" onClick={() => setPreview(false)}>
            Write
          </button>
          <button type="button" role="tab" aria-selected={preview} className="editor-tab" onClick={() => setPreview(true)}>
            Preview
          </button>
          <span className="editor-hint muted">Markdown supported</span>
        </div>
        {preview ? (
          fields.description.trim() ? (
            <Markdown text={fields.description} className="description-text is-preview" />
          ) : (
            <p className="muted description-preview-empty">Nothing to preview.</p>
          )
        ) : (
          <AutoGrowTextarea
            className="input description-input"
            aria-label="Description"
            placeholder="Details, error messages, what you tried…"
            rows={6}
            maxLength={LIMITS.description}
            value={fields.description}
            onChange={(e) => set('description', e.target.value)}
            onKeyDown={submitOnCtrlEnter}
          />
        )}
      </div>

      <fieldset className="ticket-fieldset">
        <legend className="field-inline-label">
          <ListChecks size={14} aria-hidden /> Checklist
        </legend>
        <ol className="ticket-checklist">
          {fields.checklist.map((item, i) => (
            <li key={i}>
              <input
                className="input"
                aria-label={`Checklist item ${i + 1}`}
                ref={(el) => {
                  if (el && focusRow.current === i) {
                    focusRow.current = null;
                    el.focus();
                  }
                }}
                value={item}
                maxLength={LIMITS.checklistItem}
                onChange={(e) => set('checklist', fields.checklist.map((x, j) => (j === i ? e.target.value : x)))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
                    e.preventDefault();
                    insertItem(i + 1);
                  } else submitOnCtrlEnter(e);
                }}
              />
              <button
                type="button"
                className="icon-btn"
                aria-label={`Remove checklist item ${i + 1}`}
                onClick={() => set('checklist', fields.checklist.filter((_, j) => j !== i))}
              >
                <X size={16} aria-hidden />
              </button>
            </li>
          ))}
        </ol>
        {fields.checklist.length < 50 && (
          <button type="button" className="btn btn-sm btn-subtle ticket-add-item" onClick={() => insertItem(fields.checklist.length)}>
            <Plus size={14} aria-hidden /> Add item
          </button>
        )}
      </fieldset>
    </div>
  );
}

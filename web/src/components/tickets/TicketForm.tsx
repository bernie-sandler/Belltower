// The editable fields of a new ticket, prefilled from a Claude draft or empty.

import {
  LIMITS,
  type Column,
  type CreateTicketBody,
  type Label,
  type Priority,
  type Severity,
  type TicketDraft,
} from '@tt/shared';
import { CalendarDays, Columns3, Flag, ListChecks, OctagonAlert, Plus, Tag, X } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { sortedColumns } from '../../api/board';
import { sortedLabels } from '../../api/labels';
import { AutoGrowTextarea } from '../common/AutoGrowTextarea';
import { Markdown } from '../common/Markdown';
import { PriorityHelper } from '../card/CardFields';
import { LevelPicker } from '../card/LevelPicker';
import { PRIORITY_OPTIONS, SEVERITY_OPTIONS } from '../card/levelOptions';
import { LabelChip } from '../labels/LabelChip';

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
}

export const emptyTicket = (): TicketFields => ({
  title: '',
  description: '',
  columnId: null,
  priority: null,
  severity: null,
  labelIds: [],
  dueDate: '',
  checklist: [],
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
  /** Ctrl/⌘+Enter in a text field. */
  onSubmit: () => void;
}

export function TicketForm({ fields, onChange, suggestion, columns, labels, onSubmit }: Props) {
  const id = useId();
  const [preview, setPreview] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
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
    requestAnimationFrame(() => listRef.current?.querySelectorAll('input')[at]?.focus());
  }

  return (
    <div className="ticket-form">
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
        </ul>
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
        <ol ref={listRef} className="ticket-checklist">
          {fields.checklist.map((item, i) => (
            <li key={i}>
              <input
                className="input"
                aria-label={`Checklist item ${i + 1}`}
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

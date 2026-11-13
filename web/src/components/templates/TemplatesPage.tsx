// Recurring maintenance (/templates): templates that create a Triage card on a schedule. Pause,
// edit, delete and "Create now". A template never creates a second card while its last one is open.

import {
  LIMITS,
  PRIORITIES,
  PRIORITY_CODES,
  PRIORITY_LABELS,
  type Priority,
  type RecurringTemplate,
  type TemplateBody,
  type TemplateChecklist,
} from '@tt/shared';
import { CalendarClock, Pause, Play, Pencil, Plus, Repeat, Trash2, Zap } from 'lucide-react';
import { useState } from 'react';
import { useBoard } from '../../api/board';
import { isApiError } from '../../api/client';
import { errorMessage } from '../../api/errors';
import { useTemplateActions, useTemplates } from '../../api/phase3';
import { cls } from '../../lib/cls';
import { useOpenCard } from '../../lib/navigation';
import { formatDateTime, formatLocalDate, todayLocal, useNow } from '../../lib/time';
import { toast } from '../../lib/toast';
import { AutoGrowTextarea } from '../common/AutoGrowTextarea';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { Modal } from '../common/Modal';
import { Spinner } from '../common/Status';
import { LabelChip } from '../labels/LabelChip';
import { useIsRestricted } from '../../api/me';

const UNIT_NAMES = { day: 'day', week: 'week', month: 'month' } as const;

export function describeSchedule(t: Pick<RecurringTemplate, 'intervalUnit' | 'intervalCount'>): string {
  const u = UNIT_NAMES[t.intervalUnit];
  return t.intervalCount === 1 ? `Every ${u}` : `Every ${t.intervalCount} ${u}s`;
}

export function TemplatesPage() {
  const { data, error, isPending } = useTemplates();
  const { data: board } = useBoard();
  const actions = useTemplateActions();
  // Tag-restricted people see the templates with their tags but can't change or run them.
  const restricted = useIsRestricted();
  const openCard = useOpenCard();
  const now = useNow();
  const [editing, setEditing] = useState<RecurringTemplate | 'new' | null>(null);
  const [deleting, setDeleting] = useState<RecurringTemplate | null>(null);
  const [openWarning, setOpenWarning] = useState<{ template: RecurringTemplate; cardId: number } | null>(null);
  const labelsById = new Map((board?.labels ?? []).map((l) => [l.id, l] as const));

  function runNow(t: RecurringTemplate, force = false) {
    actions.runNow.mutate(
      { id: t.id, force },
      {
        onSuccess: (card) => {
          setOpenWarning(null);
          toast(`Created “${card.title}” in Triage`, { kind: 'success', action: { label: 'Open', onClick: () => openCard(card.id) } });
        },
        onError: (err) => {
          if (isApiError(err, 'open_instance')) {
            setOpenWarning({ template: t, cardId: (err.body as { cardId: number }).cardId });
          } else toast(errorMessage(err), { kind: 'error' });
        },
      },
    );
  }

  return (
    <div className="list-page">
      <header className="list-page-header">
        <h2 className="list-page-title">
          <Repeat size={20} aria-hidden /> Recurring maintenance
        </h2>
        {!restricted && (
          <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
            <Plus size={16} aria-hidden /> New template
          </button>
        )}
      </header>
      <p className="muted">
        Each template creates a card in Triage when it comes due. If the last card it made is still open, it waits and
        notes the skipped date on that card instead of making a duplicate.
      </p>

      {isPending && <Spinner label="Loading templates…" />}
      {error && <p className="form-error">{errorMessage(error)}</p>}
      {data && data.length === 0 && <p className="muted">No templates yet.</p>}
      <ul className="template-list">
        {data?.map((t) => (
          <li key={t.id} className={cls('template-row', !t.enabled && 'is-paused')}>
            <div className="template-main">
              <div className="template-title-row">
                {t.priority && <span className={cls('badge level-badge', `prio-badge-${t.priority}`)}>{PRIORITY_CODES[t.priority]}</span>}
                <span className="template-title">{t.title}</span>
                {!t.enabled && <span className="tag">Paused</span>}
              </div>
              {t.labelIds.length > 0 && (
                <span className="tile-labels">
                  {t.labelIds.map((id) => {
                    const l = labelsById.get(id);
                    return l ? <LabelChip key={id} label={l} size="sm" /> : null;
                  })}
                </span>
              )}
              <span className="muted small">
                <CalendarClock size={12} aria-hidden /> {describeSchedule(t)} from {formatLocalDate(t.startDate)}
                {t.dueInDays !== null && ` · due ${t.dueInDays === 0 ? 'the same day' : `${t.dueInDays} day${t.dueInDays === 1 ? '' : 's'} later`}`}
                {t.checklists.length > 0 && ` · ${t.checklists.reduce((n, c) => n + c.items.length, 0)} checklist items`}
              </span>
              <span className="small">
                {t.enabled ? (
                  <>
                    Next: <strong>{formatLocalDate(t.nextRunDate, { relative: true, now })}</strong>
                    {t.upcoming.length > 1 && <span className="muted"> · then {t.upcoming.slice(1).map((d) => formatLocalDate(d)).join(', ')}</span>}
                  </>
                ) : (
                  <span className="muted">Paused: no cards will be created</span>
                )}
              </span>
              {(t.openCardId || t.lastRun) && (
                <span className="muted small">
                  {t.openCardId && (
                    <>
                      <button type="button" className="link-btn small" onClick={() => openCard(t.openCardId!)}>
                        Open card #{t.openCardId}
                      </button>{' '}
                      (no new card until it's done) ·{' '}
                    </>
                  )}
                  {t.lastRun &&
                    `Last run ${formatDateTime(t.lastRun.at, now)}: ${
                      t.lastRun.outcome === 'skipped_open' ? 'skipped (card still open)' : t.lastRun.outcome === 'manual' ? 'created by hand' : 'created a card'
                    }`}
                </span>
              )}
            </div>
            {!restricted && (
              <div className="template-actions">
                <button type="button" className="btn btn-sm" onClick={() => runNow(t)} disabled={actions.runNow.isPending}>
                  <Zap size={14} aria-hidden /> Create now
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    actions.update.mutate(
                      { id: t.id, patch: { enabled: !t.enabled } },
                      { onSuccess: () => toast(t.enabled ? 'Paused' : 'Resumed', { kind: 'success', durationMs: 2000 }) },
                    )
                  }
                >
                  {t.enabled ? <Pause size={14} aria-hidden /> : <Play size={14} aria-hidden />} {t.enabled ? 'Pause' : 'Resume'}
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setEditing(t)}>
                  <Pencil size={14} aria-hidden /> Edit
                </button>
                <button type="button" className="btn btn-sm card-action-danger" onClick={() => setDeleting(t)}>
                  <Trash2 size={14} aria-hidden /> Delete
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {editing && (
        <TemplateEditor
          template={editing === 'new' ? null : editing}
          labels={board?.labels ?? []}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete “${deleting.title}”?`}
          message="The template stops running. Cards it already created stay on the board."
          danger
          confirmLabel="Delete template"
          busy={actions.remove.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => actions.remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
        />
      )}
      {openWarning && (
        <ConfirmDialog
          title="A card from this template is still open"
          message={`Card #${openWarning.cardId} hasn't been completed yet. Create another one anyway?`}
          confirmLabel="Create anyway"
          cancelLabel="Cancel"
          onCancel={() => setOpenWarning(null)}
          onConfirm={() => runNow(openWarning.template, true)}
        />
      )}
    </div>
  );
}

// ---- editor ----

function TemplateEditor({
  template,
  labels,
  onClose,
}: {
  template: RecurringTemplate | null;
  labels: import('@tt/shared').Label[];
  onClose: () => void;
}) {
  const { create, update } = useTemplateActions();
  const [title, setTitle] = useState(template?.title ?? '');
  const [description, setDescription] = useState(template?.description ?? '');
  const [priority, setPriority] = useState<Priority | ''>(template?.priority ?? '');
  const [labelIds, setLabelIds] = useState<number[]>(template?.labelIds ?? []);
  const [unit, setUnit] = useState<TemplateBody['intervalUnit']>(template?.intervalUnit ?? 'month');
  const [count, setCount] = useState(String(template?.intervalCount ?? 1));
  const [startDate, setStartDate] = useState(template?.startDate ?? todayLocal());
  const [dueIn, setDueIn] = useState(template?.dueInDays === null || template?.dueInDays === undefined ? '' : String(template.dueInDays));
  const [enabled, setEnabled] = useState(template?.enabled ?? true);
  // Checklists edited as text: "## Title" starts a list, every other non-empty line is an item.
  const [checklistText, setChecklistText] = useState(() => toText(template?.checklists ?? []));
  const [error, setError] = useState<string | null>(null);

  function save() {
    const n = Number(count);
    if (!title.trim()) return setError('A title is required.');
    if (!Number.isInteger(n) || n < 1) return setError('"Every" must be a whole number of at least 1.');
    if (!startDate) return setError('Pick a start date.');
    const due = dueIn.trim() === '' ? null : Number(dueIn);
    if (due !== null && (!Number.isInteger(due) || due < 0)) return setError('"Due" must be a whole number of days, or empty.');
    const body: TemplateBody = {
      title: title.trim(),
      description,
      priority: priority || null,
      labelIds,
      checklists: fromText(checklistText),
      intervalUnit: unit,
      intervalCount: n,
      startDate,
      dueInDays: due,
      enabled,
    };
    const done = () => {
      toast(template ? 'Template saved' : 'Template created', { kind: 'success', durationMs: 2000 });
      onClose();
    };
    const fail = (err: unknown) => setError(errorMessage(err));
    if (template) update.mutate({ id: template.id, patch: body }, { onSuccess: done, onError: fail });
    else create.mutate(body, { onSuccess: done, onError: fail });
  }

  const busy = create.isPending || update.isPending;

  return (
    <Modal title={template ? 'Edit template' : 'New template'} size="md" onClose={onClose}>
      <form
        className="modal-body form-stack template-editor"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <label className="field">
          <span className="field-label">Card title</span>
          <input className="input" value={title} maxLength={LIMITS.cardTitle} onChange={(e) => setTitle(e.target.value)} required />
        </label>
        <div className="field">
          <span className="field-label">Schedule</span>
          <div className="schedule-row">
            <span>Every</span>
            <input className="input schedule-count" type="number" min={1} max={1000} inputMode="numeric" aria-label="Every how many" value={count} onChange={(e) => setCount(e.target.value)} />
            <select className="input select" aria-label="Unit" value={unit} onChange={(e) => setUnit(e.target.value as TemplateBody['intervalUnit'])}>
              <option value="day">day(s)</option>
              <option value="week">week(s)</option>
              <option value="month">month(s)</option>
            </select>
            <span>starting</span>
            <input className="input" type="date" aria-label="Start date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
          </div>
          <span className="field-help">
            Monthly schedules keep the start day; on shorter months they use the last day (Jan 31 → Feb 28 → Mar 31).
          </span>
        </div>
        <div className="field-row">
          <label className="field">
            <span className="field-label">Priority</span>
            <select className="input select" value={priority} onChange={(e) => setPriority(e.target.value as Priority | '')}>
              <option value="">None</option>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Due (days after it comes due)</span>
            <input className="input schedule-count" type="number" min={0} inputMode="numeric" placeholder="none" value={dueIn} onChange={(e) => setDueIn(e.target.value)} />
          </label>
        </div>
        <fieldset className="field">
          <legend className="field-label">Labels</legend>
          <div className="filter-options">
            {labels.map((l) => (
              <button
                key={l.id}
                type="button"
                className="chip filter-chip"
                aria-pressed={labelIds.includes(l.id)}
                onClick={() => setLabelIds((ids) => (ids.includes(l.id) ? ids.filter((x) => x !== l.id) : [...ids, l.id]))}
              >
                <LabelChip label={l} size="sm" />
              </button>
            ))}
          </div>
        </fieldset>
        <label className="field">
          <span className="field-label">Description (Markdown)</span>
          <AutoGrowTextarea className="input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Checklist</span>
          <AutoGrowTextarea
            className="input input-mono"
            rows={5}
            value={checklistText}
            placeholder={'## Parity check\nConfirm no disks are emulated\nRun the check'}
            onChange={(e) => setChecklistText(e.target.value)}
          />
          <span className="field-help">One item per line. A line starting with ## begins a new named checklist.</span>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Active (uncheck to pause)
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : template ? 'Save' : 'Create template'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function toText(lists: TemplateChecklist[]): string {
  return lists.map((l) => [`## ${l.title}`, ...l.items].join('\n')).join('\n\n');
}

function fromText(text: string): TemplateChecklist[] {
  const out: TemplateChecklist[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^#{1,6}\s*(.+)$/.exec(line);
    if (heading) out.push({ title: heading[1]!.trim().slice(0, LIMITS.checklistTitle), items: [] });
    else {
      if (!out.length) out.push({ title: 'Checklist', items: [] });
      out[out.length - 1]!.items.push(line.replace(/^[-*]\s*(\[ ?\]\s*)?/, '').slice(0, LIMITS.checklistItem));
    }
  }
  return out.filter((l) => l.items.length > 0);
}

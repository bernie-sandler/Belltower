// Settings → Submit page → Request types: what submitters pick first, and the questions each type
// asks. Answers are added below the submitter's description; the title follows the pattern.

import {
  REQUEST_FIELD_KINDS,
  type Label,
  type RequestFieldDef,
  type RequestFieldKind,
  type RequestType,
  type RequestTypeBody,
} from '@tt/shared';
import { ArrowDown, ArrowUp, ListChecks, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { useBoard } from '../../api/board';
import { errorMessage } from '../../api/errors';
import { sortedLabels } from '../../api/labels';
import { useRequestTypeActions, useRequestTypes } from '../../api/settings';
import { toast } from '../../lib/toast';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { Modal } from '../common/Modal';
import { LabelChip } from '../labels/LabelChip';

const KIND_LABELS: Record<RequestFieldKind, string> = {
  short: 'Short text',
  long: 'Long text',
  choice: 'Pick one',
  multi: 'Pick several',
  datetime: 'Date and time',
  yesno: 'Yes / No',
};

export function RequestTypesEditor() {
  const { data: types } = useRequestTypes();
  const { data: board } = useBoard();
  const { update, remove, reorder } = useRequestTypeActions();
  const [editing, setEditing] = useState<RequestType | 'new' | null>(null);
  const [deleting, setDeleting] = useState<RequestType | null>(null);
  const labels = board ? sortedLabels(board.labels) : [];

  const move = (i: number, by: number) => {
    if (!types) return;
    const ids = types.map((t) => t.id);
    const [id] = ids.splice(i, 1);
    ids.splice(i + by, 0, id!);
    reorder.mutate(ids);
  };

  return (
    <div className="request-types">
      <h4 className="link-group-title">What people can ask for</h4>
      <p className="muted small">
        Submitters pick one of these first, then answer its questions. Turn off the ones you don’t want offered.
      </p>
      <ul className="request-type-list">
        {(types ?? []).map((t, i) => (
          <li key={t.id} className={t.enabled ? undefined : 'is-off'}>
            <label className="checkbox request-type-toggle">
              <input
                type="checkbox"
                checked={t.enabled}
                aria-label={`Offer “${t.name}”`}
                onChange={(e) => update.mutate({ id: t.id, body: toBody({ ...t, enabled: e.target.checked }) })}
              />
            </label>
            <span className="request-type-main">
              <strong>{t.name}</strong>
              <span className="muted small">
                {t.fields.length} question{t.fields.length === 1 ? '' : 's'} · title “{t.titlePattern}”
              </span>
            </span>
            <button type="button" className="icon-btn" aria-label={`Move “${t.name}” up`} disabled={i === 0} onClick={() => move(i, -1)}>
              <ArrowUp size={16} aria-hidden />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Move “${t.name}” down`}
              disabled={i === (types?.length ?? 0) - 1}
              onClick={() => move(i, 1)}
            >
              <ArrowDown size={16} aria-hidden />
            </button>
            <button type="button" className="icon-btn" aria-label={`Edit “${t.name}”`} onClick={() => setEditing(t)}>
              <Pencil size={16} aria-hidden />
            </button>
            <button type="button" className="icon-btn" aria-label={`Delete “${t.name}”`} onClick={() => setDeleting(t)}>
              <Trash2 size={16} aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="btn btn-sm" onClick={() => setEditing('new')}>
        <Plus size={14} aria-hidden /> Add a request type
      </button>

      {editing && <RequestTypeDialog type={editing === 'new' ? null : editing} labels={labels} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog
          title={`Delete “${deleting.name}”?`}
          message="Tickets already filed keep their text. The submit page stops offering this type."
          danger
          confirmLabel="Delete"
          onCancel={() => setDeleting(null)}
          onConfirm={() => remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
        />
      )}
    </div>
  );
}

function toBody(t: Omit<RequestType, 'id' | 'position'>): RequestTypeBody {
  return {
    name: t.name,
    description: t.description,
    titlePattern: t.titlePattern,
    fields: t.fields,
    tagLabelIds: t.tagLabelIds,
    typeLabelId: t.typeLabelId,
    enabled: t.enabled,
  };
}

/** "When did it start?" → "when_did_it_start" (keys stay stable once saved). */
function keyFrom(label: string, taken: string[]): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/^[^a-z]+/, '')
      .slice(0, 24) || 'question';
  let key = base;
  for (let n = 2; taken.includes(key) || key === 'summary' || key === 'description'; n++) key = `${base}_${n}`;
  return key;
}

function RequestTypeDialog({ type, labels, onClose }: { type: RequestType | null; labels: Label[]; onClose: () => void }) {
  const { create, update } = useRequestTypeActions();
  const [name, setName] = useState(type?.name ?? '');
  const [description, setDescription] = useState(type?.description ?? '');
  const [titlePattern, setTitlePattern] = useState(type?.titlePattern ?? '{summary}');
  const [fields, setFields] = useState<RequestFieldDef[]>(type?.fields ?? []);
  const [tagLabelIds, setTagLabelIds] = useState<number[]>(type?.tagLabelIds ?? []);
  const [typeLabelId, setTypeLabelId] = useState<number | null>(type?.typeLabelId ?? null);
  const [error, setError] = useState<string | null>(null);
  const busy = create.isPending || update.isPending;

  // Keys of saved questions never change (titles may use them); a new question's key follows its wording.
  const savedKeys = new Set(type?.fields.map((f) => f.key) ?? []);
  const setField = (i: number, patch: Partial<RequestFieldDef>) =>
    setFields(
      fields.map((f, j) => {
        if (j !== i) return f;
        const next = { ...f, ...patch };
        if (patch.label !== undefined && !savedKeys.has(f.key)) {
          next.key = keyFrom(patch.label, fields.filter((_, k) => k !== i).map((x) => x.key));
        }
        return next;
      }),
    );
  const moveField = (i: number, by: number) => {
    const next = [...fields];
    const [f] = next.splice(i, 1);
    next.splice(i + by, 0, f!);
    setFields(next);
  };

  function save() {
    setError(null);
    const body = toBody({ name, description, titlePattern, fields, tagLabelIds, typeLabelId, enabled: type?.enabled ?? true });
    const done = {
      onSuccess: () => {
        toast(type ? 'Request type saved' : 'Request type added', { kind: 'success', durationMs: 2000 });
        onClose();
      },
      onError: (err: unknown) => setError(errorMessage(err)),
    };
    if (type) update.mutate({ id: type.id, body }, done);
    else create.mutate(body, done);
  }

  return (
    <Modal title={type ? `Edit “${type.name}”` : 'New request type'} variant="sheet" size="lg" onClose={onClose}>
      <div className="modal-body request-type-editor">
        <div className="field-row">
          <label className="field">
            <span className="field-label">Name</span>
            <input className="input" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="Plex" />
          </label>
          <label className="field">
            <span className="field-label">Short description</span>
            <input
              className="input"
              maxLength={300}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Playback, missing episodes…"
            />
          </label>
        </div>
        <label className="field">
          <span className="field-label">Ticket title</span>
          <input className="input input-mono" value={titlePattern} onChange={(e) => setTitlePattern(e.target.value)} />
          <span className="field-help">
            {'{summary}'} is the submitter’s title; any question’s key works too, e.g.{' '}
            {fields.slice(0, 3).map((f) => (
              <code key={f.key}>{`{${f.key}}`} </code>
            ))}
          </span>
        </label>

        <fieldset className="ticket-fieldset">
          <legend className="field-inline-label">Tags submitters can pick</legend>
          {labels.length === 0 ? (
            <p className="muted small">No labels yet. Add some under Menu → Manage labels.</p>
          ) : (
            <div className="ticket-labels">
              {labels.map((l) => {
                const on = tagLabelIds.includes(l.id);
                return (
                  <button
                    key={l.id}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    aria-label={l.name}
                    className="ticket-label-toggle"
                    onClick={() => setTagLabelIds(on ? tagLabelIds.filter((x) => x !== l.id) : [...tagLabelIds, l.id])}
                  >
                    <LabelChip label={l} />
                  </button>
                );
              })}
            </div>
          )}
        </fieldset>
        <label className="field-inline settings-inline">
          <span className="field-inline-label">Always add the label</span>
          <select className="input select" value={typeLabelId ?? ''} onChange={(e) => setTypeLabelId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">None</option>
            {labels.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>

        <fieldset className="ticket-fieldset">
          <legend className="field-inline-label">
            <ListChecks size={14} aria-hidden /> Questions (asked after “Title” and “What’s wrong?”)
          </legend>
          <ol className="question-list">
            {fields.map((f, i) => (
              <li key={i} className="question">
                <div className="question-row">
                  <input
                    className="input"
                    aria-label={`Question ${i + 1}`}
                    maxLength={120}
                    value={f.label}
                    placeholder="Question"
                    onChange={(e) => setField(i, { label: e.target.value })}
                  />
                  <select
                    className="input select"
                    aria-label={`Answer type for question ${i + 1}`}
                    value={f.kind}
                    onChange={(e) => setField(i, { kind: e.target.value as RequestFieldKind })}
                  >
                    {REQUEST_FIELD_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {KIND_LABELS[k]}
                      </option>
                    ))}
                  </select>
                  <label className="checkbox">
                    <input type="checkbox" checked={f.required} onChange={(e) => setField(i, { required: e.target.checked })} />
                    <span>Required</span>
                  </label>
                  <button type="button" className="icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => moveField(i, -1)}>
                    <ArrowUp size={16} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="Move down"
                    disabled={i === fields.length - 1}
                    onClick={() => moveField(i, 1)}
                  >
                    <ArrowDown size={16} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Remove question ${i + 1}`}
                    onClick={() => setFields(fields.filter((_, j) => j !== i))}
                  >
                    <X size={16} aria-hidden />
                  </button>
                </div>
                <div className="question-row">
                  <input
                    className="input"
                    aria-label={`Hint for question ${i + 1}`}
                    maxLength={200}
                    value={f.help}
                    placeholder="Hint (optional)"
                    onChange={(e) => setField(i, { help: e.target.value })}
                  />
                  <code className="muted small question-key" title="Use in the ticket title as {key}">{`{${f.key}}`}</code>
                </div>
                {(f.kind === 'choice' || f.kind === 'multi') && (
                  <textarea
                    className="input"
                    rows={3}
                    aria-label={`Choices for question ${i + 1}, one per line`}
                    placeholder="One choice per line"
                    value={f.options.join('\n')}
                    onChange={(e) => setField(i, { options: e.target.value.split('\n').map((o) => o.trimStart()) })}
                    onBlur={() => setField(i, { options: f.options.map((o) => o.trim()).filter(Boolean) })}
                  />
                )}
              </li>
            ))}
          </ol>
          <button
            type="button"
            className="btn btn-sm btn-subtle ticket-add-item"
            onClick={() =>
              setFields([
                ...fields,
                { key: keyFrom(`question ${fields.length + 1}`, fields.map((f) => f.key)), label: '', help: '', kind: 'short', required: false, options: [] },
              ])
            }
          >
            <Plus size={14} aria-hidden /> Add a question
          </button>
        </fieldset>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !name.trim()}
          onClick={save}
        >
          {type ? 'Save' : 'Add'}
        </button>
      </div>
    </Modal>
  );
}

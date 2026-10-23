import { LABEL_COLORS, LIMITS, type Label } from '@tt/shared';
import { ChevronDown, ChevronUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { useBoard } from '../../api/board';
import { isApiError } from '../../api/client';
import { errorMessage } from '../../api/errors';
import { sortedLabels, useCreateLabel, useDeleteLabel, useReorderLabels, useUpdateLabel } from '../../api/labels';
import { toast } from '../../lib/toast';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { Modal } from '../common/Modal';
import { Spinner } from '../common/Status';
import { ColorSwatches } from './ColorSwatches';
import { LabelChip } from './LabelChip';

function duplicateMessage(name: string): string {
  return `A label named “${name}” already exists.`;
}

export function LabelsManager({ onClose }: { onClose: () => void }) {
  const { data: board } = useBoard();
  const labels = sortedLabels(board?.labels ?? []);
  const create = useCreateLabel();
  const reorder = useReorderLabels();
  const del = useDeleteLabel();
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(LABEL_COLORS[0].hex);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Label | null>(null);

  function move(index: number, delta: -1 | 1) {
    const ids = labels.map((l) => l.id);
    const j = index + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j]!, ids[index]!];
    reorder.mutate(ids);
  }

  function add(e: FormEvent) {
    e.preventDefault();
    const clean = name.trim();
    if (!clean || create.isPending) return;
    setError(null);
    create.mutate(
      { name: clean, color },
      {
        onSuccess: () => {
          setName('');
          // Suggest the next palette color for the next label.
          const i = LABEL_COLORS.findIndex((c) => c.hex === color);
          setColor(LABEL_COLORS[(i + 1) % LABEL_COLORS.length]!.hex);
        },
        onError: (err) => setError(isApiError(err, 'duplicate_name') ? duplicateMessage(clean) : errorMessage(err)),
      },
    );
  }

  return (
    <>
      <Modal title="Labels" onClose={onClose} size="md">
        <div className="modal-body labels-manager">
          {!board ? (
            <Spinner />
          ) : labels.length === 0 ? (
            <p className="muted">No labels yet. Add one below.</p>
          ) : (
            <ul className="label-rows">
              {labels.map((l, i) => (
                <LabelRow
                  key={l.id}
                  label={l}
                  index={i}
                  count={labels.length}
                  onMove={move}
                  onDelete={() => setDeleting(l)}
                />
              ))}
            </ul>
          )}

          <form className="label-new" onSubmit={add}>
            <h3 className="section-title">New label</h3>
            <div className="label-new-row">
              <input
                className="input"
                placeholder="Label name"
                aria-label="New label name"
                maxLength={LIMITS.labelName}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
              />
              <button type="submit" className="btn btn-primary" disabled={!name.trim() || create.isPending}>
                <Plus size={16} aria-hidden /> Add
              </button>
            </div>
            <ColorSwatches value={color} onChange={setColor} label="New label color" />
            {name.trim() && (
              <div className="label-preview">
                Preview: <LabelChip label={{ name: name.trim(), color }} />
              </div>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
          </form>
        </div>
      </Modal>

      {deleting && (
        <ConfirmDialog
          title={`Delete label “${deleting.name}”?`}
          message="This removes it from all cards. Each card's history keeps a note of it."
          danger
          confirmLabel="Delete label"
          busy={del.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() =>
            del.mutate(deleting.id, {
              onSuccess: () => {
                toast(`Deleted label “${deleting.name}”`, { kind: 'success' });
                setDeleting(null);
              },
            })
          }
        />
      )}
    </>
  );
}

interface RowProps {
  label: Label;
  index: number;
  count: number;
  onMove: (index: number, delta: -1 | 1) => void;
  onDelete: () => void;
}

function LabelRow({ label, index, count, onMove, onDelete }: RowProps) {
  const update = useUpdateLabel();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label.name);
  const [colorOpen, setColorOpen] = useState(false);
  const [colorDraft, setColorDraft] = useState(label.color);
  const [error, setError] = useState<string | null>(null);
  // Esc cancels the rename; the blur that follows the input unmounting must not save it.
  const editingRef = useRef(false);
  // Same for the palette: a blur fired as it closes must not save a stale preview color.
  const paletteRef = useRef(false);

  function start() {
    setDraft(label.name);
    setError(null);
    editingRef.current = true;
    setEditing(true);
  }

  function stopEditing() {
    editingRef.current = false;
    setEditing(false);
  }

  function commit() {
    if (!editingRef.current) return;
    const clean = draft.trim();
    stopEditing();
    if (!clean || clean === label.name) return;
    update.mutate(
      { id: label.id, patch: { name: clean } },
      { onError: (err) => setError(isApiError(err, 'duplicate_name') ? duplicateMessage(clean) : errorMessage(err)) },
    );
  }

  function toggleColors() {
    setColorDraft(label.color);
    paletteRef.current = !colorOpen;
    setColorOpen(!colorOpen);
  }

  function saveColor(hex: string) {
    if (hex === label.color) return;
    update.mutate({ id: label.id, patch: { color: hex } }, { onError: (err) => setError(errorMessage(err)) });
  }

  // Tap/click/Enter picks a color and closes the palette; arrowing through it only previews the
  // color, which is saved when focus leaves the palette.
  function pickColor(hex: string, via: 'pointer' | 'keyboard') {
    setColorDraft(hex);
    if (via === 'keyboard') return;
    paletteRef.current = false;
    setColorOpen(false);
    saveColor(hex);
  }

  return (
    <li className="label-row">
      <div className="label-row-main">
        <button
          type="button"
          className="swatch swatch-btn"
          style={{ backgroundColor: colorOpen ? colorDraft : label.color }}
          aria-label={`Change color of “${label.name}”`}
          aria-expanded={colorOpen}
          onClick={toggleColors}
        />
        {editing ? (
          <input
            className="input label-row-input"
            aria-label="Label name"
            value={draft}
            maxLength={LIMITS.labelName}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                stopEditing();
              }
            }}
            onBlur={commit}
          />
        ) : (
          // Mouse/touch shortcut for renaming; keyboard users have the Rename button next to it.
          <button type="button" className="label-row-name" onClick={start} title="Click to rename" tabIndex={-1}>
            <LabelChip label={{ name: label.name, color: colorOpen ? colorDraft : label.color }} />
          </button>
        )}
        <div className="label-row-actions">
          <button type="button" className="icon-btn" aria-label={`Rename “${label.name}”`} onClick={start}>
            <Pencil size={16} aria-hidden />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={`Move “${label.name}” up`}
            disabled={index === 0}
            onClick={() => onMove(index, -1)}
          >
            <ChevronUp size={16} aria-hidden />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={`Move “${label.name}” down`}
            disabled={index === count - 1}
            onClick={() => onMove(index, 1)}
          >
            <ChevronDown size={16} aria-hidden />
          </button>
          <button type="button" className="icon-btn is-danger" aria-label={`Delete “${label.name}”`} onClick={onDelete}>
            <Trash2 size={16} aria-hidden />
          </button>
        </div>
      </div>
      {colorOpen && (
        <div
          onBlur={(e) => {
            if (paletteRef.current && !e.currentTarget.contains(e.relatedTarget as Node | null)) saveColor(colorDraft);
          }}
        >
          <ColorSwatches value={colorDraft} onChange={pickColor} label={`Color for “${label.name}”`} />
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

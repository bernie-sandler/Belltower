// Assignee (with Teams on), priority (P0–P3, with an impact × urgency helper), severity (S1–S4),
// due date (+ optional time) and completion date. Each control saves on its own as soon as it
// changes; native inputs keep it quick on a phone (iOS shows its own pickers).

import {
  LEVELS,
  PRIORITY_CODES,
  PRIORITY_LABELS,
  PRIORITY_MATRIX,
  SEVERITY_DESCRIPTIONS,
  SEVERITY_LABELS,
  type CardDetail,
  type Level,
  type Priority,
  type Severity,
} from '@tt/shared';
import { CircleCheck, Clock, Flag, Grid3x3, OctagonAlert, UserRound, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { usePerson } from '../../api/assignees';
import { useTeams } from '../../api/config';
import { useUpdateCard, type CardPatch } from '../../api/cards';
import { useMe, useUsers } from '../../api/me';
import { cls } from '../../lib/cls';
import { dueStatus, formatDateTime, formatDue, fromLocalInput, toLocalInput, useNow } from '../../lib/time';
import { toast } from '../../lib/toast';
import { Popover } from '../common/Popover';
import { LevelPicker } from './LevelPicker';
import { PRIORITY_OPTIONS, SEVERITY_OPTIONS } from './levelOptions';

export function CardFields({ card, readOnly }: { card: CardDetail; readOnly: boolean }) {
  const update = useUpdateCard(card.id);
  const now = useNow();
  const due = dueStatus(card, now);
  const teams = useTeams();

  // useUpdateCard reports failures itself (conflicts, Trash, errors).
  function save(patch: CardPatch, done?: string) {
    update.mutate(patch, { onSuccess: () => done && toast(done, { kind: 'success', durationMs: 2000 }) });
  }

  return (
    <section className="card-section card-fields" aria-label="Details">
      {teams && (
        <div className="field-row">
          <AssigneeField card={card} readOnly={readOnly} onSave={save} />
        </div>
      )}
      <div className="field-row">
        <div className="field-inline">
          <span className="field-inline-label" id={`prio-${card.id}`}>
            <Flag size={14} aria-hidden /> Priority
          </span>
          <LevelPicker
            labelledBy={`prio-${card.id}`}
            value={card.priority}
            options={PRIORITY_OPTIONS}
            disabled={readOnly}
            onChange={(priority) => save({ priority })}
          />
          {!readOnly && <PriorityHelper value={card.priority} onPick={(p) => save({ priority: p })} />}
        </div>

        <div className="field-inline">
          <span className="field-inline-label" id={`sev-${card.id}`}>
            <OctagonAlert size={14} aria-hidden /> Severity
          </span>
          <LevelPicker
            labelledBy={`sev-${card.id}`}
            value={card.severity}
            options={SEVERITY_OPTIONS}
            disabled={readOnly}
            onChange={(severity) => save({ severity })}
          />
        </div>

        <DueField card={card} readOnly={readOnly} onSave={save} />
      </div>

      {card.severity && (
        <p className="field-hint muted small">
          {SEVERITY_LABELS[card.severity]}: {SEVERITY_DESCRIPTIONS[card.severity]}
        </p>
      )}

      {card.dueDate && (
        <p className={cls('field-status', due && `due-text-${due}`)}>
          <Clock size={14} aria-hidden /> Due {formatDue(card.dueDate, card.dueTime, { relative: true, now })}
          {due === 'overdue' && ' · overdue'}
          {due === 'soon' && ' · due soon'}
          {card.completedAt && ' · done'}
        </p>
      )}

      {card.completedAt && <CompletedField card={card} readOnly={readOnly} onSave={save} now={now} />}
    </section>
  );
}

/**
 * Who has the card: active people, "Unassigned", and an "Assign to me" shortcut. Someone who was
 * deactivated while assigned still shows (they can be replaced or removed, not picked again).
 */
function AssigneeField({ card, readOnly, onSave }: { card: CardDetail; readOnly: boolean; onSave: (p: CardPatch) => void }) {
  const me = useMe().data;
  const users = useUsers();
  const active = (users.data ?? []).filter((u) => !u.disabled);
  const current = usePerson(card.assigneeId);
  const id = `assignee-${card.id}`;
  return (
    <div className="field-inline assignee-field">
      <label className="field-inline-label" htmlFor={id}>
        <UserRound size={14} aria-hidden /> Assignee
      </label>
      <select
        id={id}
        className="input"
        value={card.assigneeId ?? ''}
        disabled={readOnly}
        onChange={(e) => onSave({ assigneeId: e.target.value ? Number(e.target.value) : null })}
      >
        <option value="">Unassigned</option>
        {active.map((u) => (
          <option key={u.id} value={u.id}>
            {u.id === me?.id ? `${u.displayName} (me)` : u.displayName}
          </option>
        ))}
        {current?.disabled && (
          <option value={current.id} disabled>
            {current.displayName} (deactivated)
          </option>
        )}
        {card.assigneeId !== null && !current && (
          <option value={card.assigneeId} disabled>
            {users.isPending ? 'Loading…' : 'Someone no longer listed'}
          </option>
        )}
      </select>
      {!readOnly && me && !me.disabled && card.assigneeId !== me.id && (
        <button type="button" className="btn btn-sm" onClick={() => onSave({ assigneeId: me.id })}>
          Assign to me
        </button>
      )}
    </div>
  );
}

function DueField({
  card,
  readOnly,
  onSave,
}: {
  card: CardDetail;
  readOnly: boolean;
  onSave: (p: CardPatch) => void;
}) {
  const [date, setDate] = useState(card.dueDate ?? '');
  const [time, setTime] = useState(card.dueTime ?? '');
  useEffect(() => {
    setDate(card.dueDate ?? '');
    setTime(card.dueTime ?? '');
  }, [card.dueDate, card.dueTime]);

  function commit(nextDate: string, nextTime: string) {
    const d = nextDate || null;
    const t = d && nextTime ? nextTime : null;
    if (d === card.dueDate && t === card.dueTime) return;
    onSave({ dueDate: d, dueTime: t });
  }

  return (
    <div className="field-inline due-field">
      <span className="field-inline-label">
        <Clock size={14} aria-hidden /> Due
      </span>
      <div className="due-inputs">
        <input
          type="date"
          className="input"
          aria-label="Due date"
          value={date}
          disabled={readOnly}
          onChange={(e) => {
            setDate(e.target.value);
            // iOS fires change as the wheel spins; the value is complete either way.
            commit(e.target.value, time);
          }}
        />
        <input
          type="time"
          className="input"
          aria-label="Due time (optional)"
          value={time}
          disabled={readOnly || !date}
          onChange={(e) => {
            setTime(e.target.value);
            // Time inputs report only complete values ('' when cleared).
            if (e.target.value === '' || /^\d{2}:\d{2}$/.test(e.target.value)) commit(date, e.target.value);
          }}
        />
        {date && !readOnly && (
          <button
            type="button"
            className="icon-btn"
            aria-label="Remove due date"
            onClick={() => {
              setDate('');
              setTime('');
              commit('', '');
            }}
          >
            <X size={16} aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}

function CompletedField({
  card,
  readOnly,
  onSave,
  now,
}: {
  card: CardDetail;
  readOnly: boolean;
  onSave: (p: CardPatch, done?: string) => void;
  now: number;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');

  if (!editing) {
    return (
      <p className="field-status is-done">
        <CircleCheck size={14} aria-hidden /> Completed {formatDateTime(card.completedAt!, now)}
        {!readOnly && (
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setValue(toLocalInput(card.completedAt!));
              setEditing(true);
            }}
          >
            Change
          </button>
        )}
      </p>
    );
  }

  return (
    <div className="field-inline completed-edit">
      <span className="field-inline-label">
        <CircleCheck size={14} aria-hidden /> Completed on
      </span>
      <input
        type="datetime-local"
        className="input"
        aria-label="Completed on"
        value={value}
        max={toLocalInput(now)}
        onChange={(e) => setValue(e.target.value)}
      />
      <button
        type="button"
        className="btn btn-sm btn-primary"
        onClick={() => {
          const iso = fromLocalInput(value);
          if (!iso) return;
          setEditing(false);
          if (iso !== card.completedAt) onSave({ completedAt: iso }, 'Completion date updated');
        }}
      >
        Save
      </button>
      <button type="button" className="btn btn-sm" onClick={() => setEditing(false)}>
        Cancel
      </button>
    </div>
  );
}

const LEVEL_NAMES: Record<Level, string> = { high: 'High', medium: 'Medium', low: 'Low' };

/** "Help me choose": the impact × urgency matrix; tapping a cell sets that priority. */
export function PriorityHelper({ value, onPick }: { value: Priority | null; onPick: (p: Priority) => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <button
        type="button"
        className="icon-btn"
        aria-label="Choose priority from impact and urgency"
        title="Impact × urgency"
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      >
        <Grid3x3 size={16} aria-hidden />
      </button>
      {anchor && (
        <Popover
          anchor={anchor}
          onClose={() => setAnchor(null)}
          role="dialog"
          ariaLabel="Priority matrix"
          className="matrix-popover"
          placement="bottom-center"
        >
          <p className="popover-title">Priority matrix</p>
          <table className="priority-matrix">
            <thead>
              <tr>
                <th scope="col" className="matrix-corner">
                  Impact ↓ / Urgency →
                </th>
                {LEVELS.map((u) => (
                  <th key={u} scope="col">
                    {LEVEL_NAMES[u]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {LEVELS.map((impact) => (
                <tr key={impact}>
                  <th scope="row">{LEVEL_NAMES[impact]}</th>
                  {LEVELS.map((urgency) => {
                    const p = PRIORITY_MATRIX[impact][urgency];
                    return (
                      <td key={urgency}>
                        <button
                          type="button"
                          className={cls('matrix-cell', `prio-badge-${p}`, value === p && 'is-current')}
                          aria-label={`Impact ${LEVEL_NAMES[impact]}, urgency ${LEVEL_NAMES[urgency]}: ${PRIORITY_LABELS[p]}`}
                          onClick={() => {
                            onPick(p);
                            setAnchor(null);
                          }}
                        >
                          <strong>{PRIORITY_CODES[p]}</strong> {PRIORITY_LABELS[p].slice(3)}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </Popover>
      )}
    </>
  );
}

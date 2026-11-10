// The card's history (newest first by effective time) plus the work log: a "Log work" composer
// with quick backdating and @ autocomplete, and per-entry edit (old versions kept and viewable)
// and retract. Each entry says who did it; only a work-log entry's author or an admin can edit or
// retract it. @mentions of people are highlighted, and notify them (the server decides who).

import type { ActivityEntry } from '@tt/shared';
import { History, NotebookPen, Pencil, RotateCcw, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useCardActivity } from '../../api/cards';
import { useRevisions, useWorklogActions } from '../../api/cardParts';
import { errorMessage } from '../../api/errors';
import { useMe, useMentionPeople, useUsers } from '../../api/me';
import type { MentionPeople } from '../../lib/markdown';
import { cls } from '../../lib/cls';
import { clearDraft, loadDraft, saveDraft } from '../../lib/drafts';
import { formatDateTime, fromLocalInput, todayLocal, toLocalInput, useNow } from '../../lib/time';
import { toast } from '../../lib/toast';
import { Markdown } from '../common/Markdown';
import { Spinner } from '../common/Status';
import { activityActor, activityText } from './activityText';
import { MentionTextarea } from './MentionTextarea';

type Filter = 'all' | 'worklog';

export function ActivityList({
  cardId,
  readOnly,
  composeRequest,
}: {
  cardId: number;
  readOnly: boolean;
  /** Bumped by the "Log work" buttons: focus the composer. */
  composeRequest: number;
}) {
  const { data, error, isPending, refetch } = useCardActivity(cardId);
  const { data: me } = useMe();
  const people = useMentionPeople();
  const now = useNow();
  const [filter, setFilter] = useState<Filter>('all');
  const entries = (data ?? []).filter((e) => filter === 'all' || e.kind === 'worklog');

  return (
    <section className="card-section" aria-labelledby="card-activity-heading">
      <div className="card-section-head">
        <h3 id="card-activity-heading" className="card-section-title">
          <History size={16} aria-hidden /> Activity
        </h3>
        <div className="segmented segmented-sm" role="radiogroup" aria-label="Show">
          {(
            [
              ['all', 'All'],
              ['worklog', 'Work log'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={filter === value}
              className="segmented-item"
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {!readOnly && <WorklogComposer cardId={cardId} focusRequest={composeRequest} />}

      {isPending && <Spinner label="Loading activity…" />}
      {!isPending && !data && (
        <p className="muted">
          {errorMessage(error)}{' '}
          <button type="button" className="link-btn" onClick={() => void refetch()}>
            Retry
          </button>
        </p>
      )}
      {data && entries.length === 0 && (
        <p className="muted">{filter === 'worklog' ? 'No work logged yet.' : 'No activity yet.'}</p>
      )}
      {entries.length > 0 && (
        <ol className="activity-list">
          {entries.map((entry) =>
            entry.kind === 'worklog' ? (
              <WorklogEntry
                key={entry.id}
                entry={entry}
                cardId={cardId}
                now={now}
                people={people}
                readOnly={readOnly || !mayChangeWorklog(entry, me)}
              />
            ) : (
              <li key={entry.id} className="activity-item">
                <div className="activity-line">
                  <span className="activity-text">{activityText(entry)}</span>
                  <ActivityBy entry={entry} />
                  <time className="activity-time" dateTime={entry.occurredAt}>
                    {formatDateTime(entry.occurredAt, now)}
                  </time>
                </div>
              </li>
            ),
          )}
        </ol>
      )}
    </section>
  );
}

/** Its author or an admin (entries without an author are admin-only); unknown until /api/me loads. */
function mayChangeWorklog(entry: ActivityEntry, me: { id: number; role: string } | undefined): boolean {
  if (!me) return false;
  return me.role === 'admin' || (entry.userId !== null && entry.userId === me.id);
}

/** Who did it, beside the time ("Alice", "via API token “Kuma” (Alice)", "submit page (Sam)"). */
function ActivityBy({ entry }: { entry: ActivityEntry }) {
  const by = activityActor(entry);
  // Display names aren't unique; the username tells two Alexes apart.
  return by ? (
    <span className="activity-by" title={entry.userUsername ? `@${entry.userUsername}` : undefined}>
      {by}
    </span>
  ) : null;
}

// ---- composer ----

type When = 'now' | '1h' | 'morning' | 'yesterday' | 'custom';

const WHEN_LABELS: Record<When, string> = {
  now: 'Now',
  '1h': '1h ago',
  morning: 'This morning',
  yesterday: 'Yesterday',
  custom: 'Pick time…',
};

/** The effective time for a quick choice, or undefined for "now". */
function whenToIso(when: When, custom: string, now: number): string | undefined | null {
  switch (when) {
    case 'now':
      return undefined;
    case '1h':
      return new Date(now - 3_600_000).toISOString();
    case 'morning':
      return fromLocalInput(`${todayLocal(now)}T09:00`);
    case 'yesterday': {
      // Same clock time yesterday.
      const t = toLocalInput(now).split('T')[1]!;
      const y = toLocalInput(now - 86_400_000).split('T')[0]!;
      return fromLocalInput(`${y}T${t}`);
    }
    case 'custom':
      return custom ? fromLocalInput(custom) : null;
  }
}

function WorklogComposer({ cardId, focusRequest }: { cardId: number; focusRequest: number }) {
  const draftKey = `card:${cardId}:worklog`;
  const { add } = useWorklogActions(cardId);
  const { data: users } = useUsers();
  const now = useNow();
  const [body, setBody] = useState(() => loadDraft(draftKey, true) ?? '');
  const [when, setWhen] = useState<When>('now');
  const [custom, setCustom] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const seen = useRef(focusRequest);

  useEffect(() => {
    if (focusRequest === seen.current) return;
    seen.current = focusRequest;
    ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    ref.current?.focus({ preventScroll: true });
  }, [focusRequest]);

  const morningInFuture = when === 'morning' && Date.parse(fromLocalInput(`${todayLocal(now)}T09:00`) ?? '') > now;

  function submit() {
    const text = body.trim();
    if (!text) return;
    const occurredAt = whenToIso(when, custom, Date.now());
    if (occurredAt === null) {
      toast('Pick when the work happened', { kind: 'warning' });
      return;
    }
    if (occurredAt && Date.parse(occurredAt) > Date.now() + 60_000) {
      toast("The time can't be in the future", { kind: 'warning' });
      return;
    }
    add.mutate(
      { bodyMd: text, ...(occurredAt ? { occurredAt } : {}) },
      {
        onSuccess: () => {
          setBody('');
          clearDraft(draftKey, true);
          setWhen('now');
          setCustom('');
          toast('Work logged', { kind: 'success', durationMs: 2000 });
        },
      },
    );
  }

  return (
    <div className="worklog-composer">
      <MentionTextarea
        ref={ref}
        className="input"
        aria-label="Log work"
        placeholder="Log work… e.g. Swapped SATA power cable to drive 3 (Markdown OK, @name to mention someone)"
        rows={2}
        value={body}
        people={users ?? []}
        onValueChange={(v) => {
          setBody(v);
          saveDraft(draftKey, v, true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="worklog-when" role="radiogroup" aria-label="When">
        {(Object.keys(WHEN_LABELS) as When[]).map((w) => (
          <button
            key={w}
            type="button"
            role="radio"
            aria-checked={when === w}
            className="chip"
            onClick={() => {
              setWhen(w);
              if (w === 'custom' && !custom) setCustom(toLocalInput(Date.now()));
            }}
          >
            {WHEN_LABELS[w]}
          </button>
        ))}
        {when === 'custom' && (
          <input
            type="datetime-local"
            className="input"
            aria-label="When the work happened"
            value={custom}
            max={toLocalInput(now)}
            onChange={(e) => setCustom(e.target.value)}
          />
        )}
      </div>
      {morningInFuture && <p className="muted small">It isn't 9 AM yet; pick another time.</p>}
      <div className="editor-actions">
        <button type="button" className="btn btn-primary" onClick={submit} disabled={!body.trim() || add.isPending || morningInFuture}>
          <NotebookPen size={16} aria-hidden /> {add.isPending ? 'Saving…' : 'Log work'}
        </button>
        {body && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              setBody('');
              clearDraft(draftKey, true);
            }}
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

// ---- one work-log entry ----

function WorklogEntry({
  entry,
  cardId,
  now,
  people,
  readOnly,
}: {
  entry: ActivityEntry;
  cardId: number;
  now: number;
  people: MentionPeople | undefined;
  readOnly: boolean;
}) {
  const { update } = useWorklogActions(cardId);
  const { data: users } = useUsers();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState('');
  const [time, setTime] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const retracted = entry.retractedAt !== null;

  function save() {
    const text = body.trim();
    const occurredAt = fromLocalInput(time);
    if (!text || !occurredAt) return;
    update.mutate(
      {
        id: entry.id,
        ...(text !== entry.bodyMd ? { bodyMd: text } : {}),
        ...(occurredAt !== entry.occurredAt && time !== toLocalInput(entry.occurredAt) ? { occurredAt } : {}),
      },
      { onSuccess: () => setEditing(false) },
    );
  }

  return (
    <li className={cls('activity-item is-worklog', retracted && 'is-retracted')}>
      <div className="activity-line">
        <span className="activity-text">
          <NotebookPen size={14} aria-hidden /> Logged work
          {entry.editedAt && (
            <button type="button" className="link-btn small" onClick={() => setShowHistory((s) => !s)}>
              (edited {formatDateTime(entry.editedAt, now)})
            </button>
          )}
        </span>
        <ActivityBy entry={entry} />
        <time className="activity-time" dateTime={entry.occurredAt} title={entry.createdAt !== entry.occurredAt ? `Written ${formatDateTime(entry.createdAt, now)}` : undefined}>
          {formatDateTime(entry.occurredAt, now)}
        </time>
      </div>

      {editing ? (
        <div className="worklog-edit">
          <MentionTextarea
            className="input"
            aria-label="Edit work-log entry"
            value={body}
            rows={2}
            people={users ?? []}
            onValueChange={setBody}
            autoFocus
          />
          <label className="field-inline">
            <span className="field-inline-label">When</span>
            <input type="datetime-local" className="input" value={time} max={toLocalInput(now)} onChange={(e) => setTime(e.target.value)} />
          </label>
          <p className="muted small">The current text is kept in this entry's history.</p>
          <div className="editor-actions">
            <button type="button" className="btn btn-sm btn-primary" onClick={save} disabled={!body.trim() || update.isPending}>
              Save
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        entry.bodyMd && <Markdown text={entry.bodyMd} className="activity-body" people={people} />
      )}

      {retracted && <p className="activity-note">Retracted {formatDateTime(entry.retractedAt!, now)}: hidden from the calendar and search.</p>}

      {!readOnly && !editing && (
        <div className="activity-actions">
          {!retracted && (
            <button
              type="button"
              className="link-btn small"
              onClick={() => {
                setBody(entry.bodyMd ?? '');
                setTime(toLocalInput(entry.occurredAt));
                setEditing(true);
              }}
            >
              <Pencil size={12} aria-hidden /> Edit
            </button>
          )}
          <button
            type="button"
            className="link-btn small"
            onClick={() => update.mutate({ id: entry.id, retracted: !retracted })}
          >
            {retracted ? (
              <>
                <Undo2 size={12} aria-hidden /> Un-retract
              </>
            ) : (
              <>
                <RotateCcw size={12} aria-hidden /> Retract
              </>
            )}
          </button>
        </div>
      )}

      {showHistory && <RevisionList activityId={entry.id} now={now} people={people} />}
    </li>
  );
}

function RevisionList({ activityId, now, people }: { activityId: number; now: number; people: MentionPeople | undefined }) {
  const { data, isPending } = useRevisions(activityId, true);
  if (isPending) return <Spinner label="Loading history…" size={16} />;
  if (!data?.length) return null;
  return (
    <ol className="revision-list" aria-label="Earlier versions">
      {data.map((r, i) => (
        <li key={r.id} className="revision">
          <p className="muted small">
            {i === 0 ? 'Original' : `Version ${i + 1}`} · for {formatDateTime(r.occurredAt, now)} · replaced{' '}
            {formatDateTime(r.revisedAt, now)}
            {r.userName && (
              <>
                {' by '}
                <span title={r.userUsername ? `@${r.userUsername}` : undefined}>{r.userName}</span>
              </>
            )}
          </p>
          <Markdown text={r.bodyMd} className="activity-body" people={people} />
        </li>
      ))}
    </ol>
  );
}

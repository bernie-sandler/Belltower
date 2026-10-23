// Search (/search): full-text search across titles, descriptions, checklists, work logs and
// history, archived cards included. Filters: label, priority, severity, column, board/archived,
// and a date range (cards with anything recorded in it). State lives in the URL.

import {
  PRIORITIES,
  PRIORITY_CODES,
  SEVERITIES,
  SEVERITY_CODES,
  type SearchField,
  type SearchResult,
} from '@tt/shared';
import { Search as SearchIcon, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { sortedColumns, useBoard } from '../../api/board';
import { errorMessage } from '../../api/errors';
import { useSearch, type SearchParams } from '../../api/phase3';
import { cls } from '../../lib/cls';
import { useOpenCard } from '../../lib/navigation';
import { formatDateTime, useNow } from '../../lib/time';
import { Spinner } from '../common/Status';
import { LabelChip } from '../labels/LabelChip';

const FIELD_NAMES: Record<SearchField, string> = {
  title: 'Title',
  description: 'Description',
  checklists: 'Checklist',
  worklogs: 'Work log',
  history: 'History',
};

const list = (v: string | null) => (v ? v.split(',').filter(Boolean) : []);

/** Text with \u0002…\u0003 hit markers → text nodes and <mark>s (never HTML). */
export function Snippet({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const re = /\u0002([^\u0003]*)\u0003/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(<mark key={i++}>{m[1]}</mark>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const { data: board } = useBoard();
  const openCard = useOpenCard();
  const now = useNow();
  const inputRef = useRef<HTMLInputElement>(null);

  const urlState: SearchParams = {
    q: params.get('q') ?? '',
    labelIds: list(params.get('labels')).map(Number),
    columnIds: list(params.get('columns')).map(Number),
    priorities: list(params.get('prio')),
    severities: list(params.get('sev')),
    status: (['board', 'archived'].includes(params.get('status') ?? '') ? params.get('status') : 'all') as SearchParams['status'],
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
  };

  // The text box updates the URL after a short pause.
  const [text, setText] = useState(urlState.q);
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (text !== urlState.q) update({ q: text });
    }, 250);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function update(patch: Partial<SearchParams>) {
    const s = { ...urlState, ...patch };
    const p = new URLSearchParams();
    if (s.q) p.set('q', s.q);
    if (s.labelIds.length) p.set('labels', s.labelIds.join(','));
    if (s.columnIds.length) p.set('columns', s.columnIds.join(','));
    if (s.priorities.length) p.set('prio', s.priorities.join(','));
    if (s.severities.length) p.set('sev', s.severities.join(','));
    if (s.status !== 'all') p.set('status', s.status);
    if (s.from) p.set('from', s.from);
    if (s.to) p.set('to', s.to);
    setParams(p, { replace: true });
  }

  function toggle(key: 'labelIds' | 'columnIds' | 'priorities' | 'severities', v: string | number) {
    const cur = urlState[key] as (string | number)[];
    update({ [key]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] } as Partial<SearchParams>);
  }

  const results = useSearch(urlState);
  const labelsById = useMemo(() => new Map((board?.labels ?? []).map((l) => [l.id, l] as const)), [board?.labels]);
  const columns = board ? sortedColumns(board.columns) : [];
  const anyFilter =
    urlState.labelIds.length + urlState.columnIds.length + urlState.priorities.length + urlState.severities.length > 0 ||
    urlState.status !== 'all' ||
    urlState.from !== '' ||
    urlState.to !== '';
  const empty = !urlState.q.trim() && !anyFilter;

  return (
    <div className="list-page search-page">
      <h2 className="list-page-title">
        <SearchIcon size={20} aria-hidden /> Search
      </h2>
      <label className="search-field search-main">
        <SearchIcon size={18} aria-hidden />
        <input
          ref={inputRef}
          className="input"
          type="search"
          placeholder="Search titles, descriptions, checklists, work logs…  (e.g. sdb1, nginx.conf, parity)"
          aria-label="Search"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>

      <details className="search-filters" open={anyFilter || undefined}>
        <summary>Filters{anyFilter && ' (active)'}</summary>
        <div className="filter-group">
          <span className="filter-group-title">Show</span>
          <div className="segmented segmented-sm" role="radiogroup" aria-label="Which cards">
            {(
              [
                ['all', 'Board + archive'],
                ['board', 'Board only'],
                ['archived', 'Archived only'],
              ] as const
            ).map(([v, label]) => (
              <button key={v} type="button" role="radio" aria-checked={urlState.status === v} className="segmented-item" onClick={() => update({ status: v })}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="filter-group">
          <span className="filter-group-title">Labels</span>
          <div className="filter-options">
            {(board?.labels ?? []).map((l) => (
              <button key={l.id} type="button" className="chip filter-chip" aria-pressed={urlState.labelIds.includes(l.id)} onClick={() => toggle('labelIds', l.id)}>
                <LabelChip label={l} size="sm" />
              </button>
            ))}
          </div>
        </div>
        <div className="filter-group">
          <span className="filter-group-title">Priority / severity</span>
          <div className="filter-options">
            {PRIORITIES.map((p) => (
              <button key={p} type="button" className="chip filter-chip" aria-pressed={urlState.priorities.includes(p)} onClick={() => toggle('priorities', p)}>
                <span className={cls('badge level-badge', `prio-badge-${p}`)}>{PRIORITY_CODES[p]}</span>
              </button>
            ))}
            {SEVERITIES.map((s) => (
              <button key={s} type="button" className="chip filter-chip" aria-pressed={urlState.severities.includes(s)} onClick={() => toggle('severities', s)}>
                <span className={cls('badge level-badge', `sev-badge-${s}`)}>{SEVERITY_CODES[s]}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="filter-group">
          <span className="filter-group-title">Column</span>
          <div className="filter-options">
            {columns.map((c) => (
              <button key={c.id} type="button" className="chip filter-chip" aria-pressed={urlState.columnIds.includes(c.id)} onClick={() => toggle('columnIds', c.id)}>
                {c.name}
              </button>
            ))}
          </div>
        </div>
        <div className="filter-group">
          <span className="filter-group-title">Activity between</span>
          <div className="filter-options">
            <input type="date" className="input" aria-label="From" value={urlState.from} onChange={(e) => update({ from: e.target.value })} />
            <span className="muted">and</span>
            <input type="date" className="input" aria-label="To" value={urlState.to} onChange={(e) => update({ to: e.target.value })} />
          </div>
        </div>
        {anyFilter && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => update({ labelIds: [], columnIds: [], priorities: [], severities: [], status: 'all', from: '', to: '' })}
          >
            <X size={14} aria-hidden /> Clear filters
          </button>
        )}
      </details>

      {empty && <p className="muted">Type to search. Archived cards are included; the Trash isn't.</p>}
      {!empty && results.isPending && <Spinner label="Searching…" />}
      {results.error && <p className="form-error">{errorMessage(results.error)}</p>}
      {!empty && results.data && (
        <>
          <p className="muted small" aria-live="polite">
            {results.data.length === 100 ? 'Showing the first 100 matches' : `${results.data.length} match${results.data.length === 1 ? '' : 'es'}`}
          </p>
          <ul className="search-results">
            {results.data.map((r) => (
              <ResultRow key={r.id} result={r} labelsById={labelsById} now={now} onOpen={() => openCard(r.id)} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function ResultRow({
  result: r,
  labelsById,
  now,
  onOpen,
}: {
  result: SearchResult;
  labelsById: Map<number, import('@tt/shared').Label>;
  now: number;
  onOpen: () => void;
}) {
  return (
    <li>
      <button type="button" className="search-result" onClick={onOpen}>
        <span className="search-result-head">
          {r.priority && <span className={cls('badge level-badge', `prio-badge-${r.priority}`)}>{PRIORITY_CODES[r.priority]}</span>}
          {r.severity && <span className={cls('badge level-badge', `sev-badge-${r.severity}`)}>{SEVERITY_CODES[r.severity]}</span>}
          <span className="search-result-title">
            <Snippet text={r.matches.find((m) => m.field === 'title')?.snippet ?? r.title} />
          </span>
        </span>
        {r.labelIds.length > 0 && (
          <span className="tile-labels">
            {r.labelIds.map((id) => {
              const l = labelsById.get(id);
              return l ? <LabelChip key={id} label={l} size="sm" /> : null;
            })}
          </span>
        )}
        {r.matches
          .filter((m) => m.field !== 'title')
          .map((m) => (
            <span key={m.field} className="search-snippet">
              <span className="search-snippet-field">{FIELD_NAMES[m.field]}:</span> <Snippet text={m.snippet} />
            </span>
          ))}
        <span className="muted small">
          #{r.id} · {r.archivedAt ? 'Archived' : r.columnName}
          {r.completedAt && ' · done'} · updated {formatDateTime(r.updatedAt, now)}
        </span>
      </button>
    </li>
  );
}

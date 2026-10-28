// Board filter bar: label, priority, severity, due status and text. Filtering happens in the
// browser over the cards already loaded; the state lives in the URL (?labels=1,2&prio=critical…),
// so it survives a reload and Back. Dragging still works while filtered: a drop is anchored to the
// card shown above it.

import {
  PRIORITIES,
  PRIORITY_CODES,
  PRIORITY_LABELS,
  SEVERITIES,
  SEVERITY_CODES,
  SEVERITY_LABELS,
  type CardTile,
  type Label,
} from '@tt/shared';
import { Filter, Search, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { cls } from '../../lib/cls';
import { dueStatus } from '../../lib/time';
import { Popover } from '../common/Popover';
import { LabelChip } from '../labels/LabelChip';

export type DueFilter = 'overdue' | 'soon' | 'has' | 'none';

export interface BoardFilter {
  text: string;
  labels: number[];
  priorities: string[];
  severities: string[];
  due: DueFilter[];
  /** 'work' and/or 'ticket'; empty = both. */
  kinds: string[];
}

const DUE_LABELS: Record<DueFilter, string> = {
  overdue: 'Overdue',
  soon: 'Due within 48h',
  has: 'Has a due date',
  none: 'No due date',
};

const list = (v: string | null) => (v ? v.split(',').filter(Boolean) : []);

export function useBoardFilter() {
  const [params, setParams] = useSearchParams();
  const filter: BoardFilter = useMemo(
    () => ({
      text: params.get('q') ?? '',
      labels: list(params.get('labels')).map(Number).filter((n) => n > 0),
      priorities: list(params.get('prio')),
      severities: list(params.get('sev')),
      due: list(params.get('due')) as DueFilter[],
      kinds: list(params.get('type')),
    }),
    [params],
  );
  const setFilter = (next: BoardFilter) => {
    const p = new URLSearchParams(params);
    const put = (k: string, v: string) => (v ? p.set(k, v) : p.delete(k));
    put('q', next.text);
    put('labels', next.labels.join(','));
    put('prio', next.priorities.join(','));
    put('sev', next.severities.join(','));
    put('due', next.due.join(','));
    put('type', next.kinds.join(','));
    setParams(p, { replace: true });
  };
  const active =
    filter.text.trim() !== '' ||
    filter.labels.length + filter.priorities.length + filter.severities.length + filter.due.length + filter.kinds.length > 0;
  return { filter, setFilter, active };
}

/** Whether a tile passes the filter. Within a group any choice matches; groups combine with AND. */
export function matchesFilter(tile: CardTile, f: BoardFilter, labelsById: Map<number, Label>, now: number): boolean {
  if (f.kinds.length && !f.kinds.includes(tile.kind)) return false;
  if (f.labels.length && !tile.labelIds.some((id) => f.labels.includes(id))) return false;
  if (f.priorities.length && !f.priorities.includes(tile.priority ?? 'none')) return false;
  if (f.severities.length && !f.severities.includes(tile.severity ?? 'none')) return false;
  if (f.due.length) {
    const st = dueStatus(tile, now);
    const ok = f.due.some((d) =>
      d === 'overdue' ? st === 'overdue' : d === 'soon' ? st === 'soon' : d === 'has' ? tile.dueDate !== null : tile.dueDate === null,
    );
    if (!ok) return false;
  }
  const text = f.text.trim().toLowerCase();
  if (text) {
    const hay = [tile.ticketNo ?? '', tile.title, ...tile.labelIds.map((id) => labelsById.get(id)?.name ?? '')].join(' ').toLowerCase();
    if (!text.split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  return true;
}

export function FilterBar({
  labels,
  filter,
  setFilter,
  active,
  shown,
  total,
}: {
  labels: Label[];
  filter: BoardFilter;
  setFilter: (f: BoardFilter) => void;
  active: boolean;
  shown: number;
  total: number;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const count = filter.labels.length + filter.priorities.length + filter.severities.length + filter.due.length + filter.kinds.length;

  function toggle<K extends 'labels' | 'priorities' | 'severities' | 'due' | 'kinds'>(key: K, value: BoardFilter[K][number]) {
    const cur = filter[key] as (typeof value)[];
    const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
    setFilter({ ...filter, [key]: next });
  }

  return (
    <div className="filter-bar" role="search" aria-label="Filter the board">
      <label className="search-field filter-text">
        <Search size={16} aria-hidden />
        <input
          className="input"
          type="search"
          placeholder="Filter cards…"
          aria-label="Filter cards by text"
          value={filter.text}
          onChange={(e) => setFilter({ ...filter, text: e.target.value })}
        />
      </label>
      <button
        type="button"
        className={cls('btn', count > 0 && 'btn-active')}
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      >
        <Filter size={16} aria-hidden /> Filters{count > 0 && ` (${count})`}
      </button>
      {active && (
        <>
          <span className="muted small filter-count" aria-live="polite">
            Showing {shown} of {total}
          </span>
          <button
            type="button"
            className="btn btn-subtle"
            onClick={() => setFilter({ text: '', labels: [], priorities: [], severities: [], due: [], kinds: [] })}
          >
            <X size={14} aria-hidden /> Clear
          </button>
        </>
      )}

      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} role="dialog" ariaLabel="Filters" className="filter-popover">
          <FilterGroup title="Type">
            <Toggle on={filter.kinds.includes('work')} onClick={() => toggle('kinds', 'work')}>
              Work cards
            </Toggle>
            <Toggle on={filter.kinds.includes('ticket')} onClick={() => toggle('kinds', 'ticket')}>
              Tickets
            </Toggle>
          </FilterGroup>
          <FilterGroup title="Labels">
            {labels.map((l) => (
              <Toggle key={l.id} on={filter.labels.includes(l.id)} onClick={() => toggle('labels', l.id)}>
                <LabelChip label={l} size="sm" />
              </Toggle>
            ))}
          </FilterGroup>
          <FilterGroup title="Priority">
            {PRIORITIES.map((p) => (
              <Toggle key={p} on={filter.priorities.includes(p)} onClick={() => toggle('priorities', p)}>
                <span className={cls('badge level-badge', `prio-badge-${p}`)}>{PRIORITY_CODES[p]}</span>{' '}
                {PRIORITY_LABELS[p].slice(3)}
              </Toggle>
            ))}
            <Toggle on={filter.priorities.includes('none')} onClick={() => toggle('priorities', 'none')}>
              None
            </Toggle>
          </FilterGroup>
          <FilterGroup title="Severity">
            {SEVERITIES.map((s) => (
              <Toggle key={s} on={filter.severities.includes(s)} onClick={() => toggle('severities', s)}>
                <span className={cls('badge level-badge', `sev-badge-${s}`)}>{SEVERITY_CODES[s]}</span>{' '}
                {SEVERITY_LABELS[s].slice(3)}
              </Toggle>
            ))}
            <Toggle on={filter.severities.includes('none')} onClick={() => toggle('severities', 'none')}>
              None
            </Toggle>
          </FilterGroup>
          <FilterGroup title="Due">
            {(Object.keys(DUE_LABELS) as DueFilter[]).map((d) => (
              <Toggle key={d} on={filter.due.includes(d)} onClick={() => toggle('due', d)}>
                {DUE_LABELS[d]}
              </Toggle>
            ))}
          </FilterGroup>
        </Popover>
      )}
    </div>
  );
}

function FilterGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="filter-group">
      <legend className="filter-group-title">{title}</legend>
      <div className="filter-options">{children}</div>
    </fieldset>
  );
}

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="chip filter-chip" aria-pressed={on} onClick={onClick}>
      {children}
    </button>
  );
}

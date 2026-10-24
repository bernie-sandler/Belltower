// Calendar (/calendar): month grid or week agenda of what was due, what got done, and what work
// was logged, by local day in the app time zone. The three kinds differ by shape as well as color:
// due = ring, completed = check, work log = pen. Clicking a day lists everything on it; clicking
// an item opens its card (over the calendar).

import { PRIORITY_CODES, type CalendarItem } from '@tt/shared';
import { CalendarDays, ChevronLeft, ChevronRight, CircleCheck, Clock, NotebookPen } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useCalendar } from '../../api/phase3';
import { errorMessage } from '../../api/errors';
import { cls } from '../../lib/cls';
import { useOpenCard } from '../../lib/navigation';
import {
  addLocalDays,
  addMonthsLocal,
  dueStatus,
  formatClock,
  formatDayLong,
  formatMonth,
  startOfMonth,
  startOfWeek,
  todayLocal,
  useNow,
} from '../../lib/time';
import { Modal } from '../common/Modal';
import { Spinner } from '../common/Status';
import { TicketTitle } from '../common/TicketTitle';

type View = 'month' | 'week';

const KIND_META = {
  due: { label: 'Due', icon: Clock },
  completed: { label: 'Completed', icon: CircleCheck },
  worklog: { label: 'Work logged', icon: NotebookPen },
} as const;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function CalendarPage() {
  const now = useNow();
  const today = todayLocal(now);
  const [params, setParams] = useSearchParams();
  const view: View = params.get('view') === 'week' ? 'week' : 'month';
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(params.get('d') ?? '') ? params.get('d')! : today;
  const [openDay, setOpenDay] = useState<string | null>(null);

  const from = view === 'month' ? startOfWeek(startOfMonth(anchor)) : startOfWeek(anchor);
  const days = view === 'month' ? 42 : 7;
  const to = addLocalDays(from, days - 1);
  const { data, error, isPending } = useCalendar(from, to);

  const byDay = useMemo(() => {
    const m = new Map<string, CalendarItem[]>();
    for (const it of data ?? []) {
      const list = m.get(it.date);
      if (list) list.push(it);
      else m.set(it.date, [it]);
    }
    return m;
  }, [data]);

  function go(next: { view?: View; d?: string }) {
    const p = new URLSearchParams(params);
    p.set('view', next.view ?? view);
    p.set('d', next.d ?? anchor);
    setParams(p, { replace: true });
  }

  const step = (dir: -1 | 1) =>
    go({ d: view === 'month' ? addMonthsLocal(startOfMonth(anchor), dir) : addLocalDays(anchor, 7 * dir) });

  const title = view === 'month' ? formatMonth(anchor) : `Week of ${formatDayLong(from)}`;
  const dayList = Array.from({ length: days }, (_, i) => addLocalDays(from, i));

  return (
    <div className="calendar-page">
      <header className="calendar-header">
        <h2 className="list-page-title">
          <CalendarDays size={20} aria-hidden /> {title}
        </h2>
        <div className="calendar-controls">
          <button type="button" className="icon-btn" aria-label={`Previous ${view}`} onClick={() => step(-1)}>
            <ChevronLeft size={20} aria-hidden />
          </button>
          <button type="button" className="btn btn-sm" onClick={() => go({ d: today })}>
            Today
          </button>
          <button type="button" className="icon-btn" aria-label={`Next ${view}`} onClick={() => step(1)}>
            <ChevronRight size={20} aria-hidden />
          </button>
          <div className="segmented segmented-sm" role="radiogroup" aria-label="View">
            {(['month', 'week'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={view === v}
                className="segmented-item"
                onClick={() => go({ view: v })}
              >
                {v === 'month' ? 'Month' : 'Week'}
              </button>
            ))}
          </div>
        </div>
      </header>

      <ul className="calendar-legend" aria-label="Legend">
        {(Object.keys(KIND_META) as CalendarItem['kind'][]).map((k) => {
          const Icon = KIND_META[k].icon;
          return (
            <li key={k} className={cls('cal-kind', `cal-${k}`)}>
              <Icon size={14} aria-hidden /> {KIND_META[k].label}
            </li>
          );
        })}
      </ul>

      {error && <p className="form-error">{errorMessage(error)}</p>}
      {isPending && <Spinner label="Loading calendar…" />}

      {view === 'month' ? (
        <div className="month-grid" role="grid" aria-label={title}>
          {WEEKDAYS.map((w) => (
            <div key={w} className="month-weekday" role="columnheader">
              {w}
            </div>
          ))}
          {dayList.map((d) => {
            const items = byDay.get(d) ?? [];
            const inMonth = d.slice(0, 7) === anchor.slice(0, 7);
            return (
              <button
                key={d}
                type="button"
                role="gridcell"
                className={cls('month-day', !inMonth && 'is-outside', d === today && 'is-today', items.length > 0 && 'has-items')}
                aria-label={`${formatDayLong(d)}: ${items.length ? `${items.length} item${items.length === 1 ? '' : 's'}` : 'nothing'}`}
                onClick={() => setOpenDay(d)}
              >
                <span className="month-day-num">{Number(d.slice(8))}</span>
                <span className="month-day-items">
                  {items.slice(0, 3).map((it, i) => (
                    <CalendarChip key={i} item={it} now={now} compact />
                  ))}
                  {items.length > 3 && <span className="month-more">+{items.length - 3} more</span>}
                </span>
                {/* Phones: one marker per kind instead of titles. */}
                <span className="month-day-markers" aria-hidden>
                  {(['due', 'completed', 'worklog'] as const)
                    .filter((k) => items.some((i) => i.kind === k))
                    .map((k) => {
                      const Icon = KIND_META[k].icon;
                      return <Icon key={k} size={12} className={`cal-${k}`} />;
                    })}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <ol className="week-agenda">
          {dayList.map((d) => {
            const items = byDay.get(d) ?? [];
            return (
              <li key={d} className={cls('week-day', d === today && 'is-today')}>
                <h3 className="week-day-title">{formatDayLong(d)}</h3>
                {items.length ? (
                  <DayItems items={items} now={now} />
                ) : (
                  <p className="muted small">Nothing.</p>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {openDay && (
        <Modal title={formatDayLong(openDay)} variant="sheet" size="md" onClose={() => setOpenDay(null)}>
          <div className="modal-body">
            {(byDay.get(openDay) ?? []).length ? (
              <DayItems items={byDay.get(openDay)!} now={now} onOpen={() => setOpenDay(null)} />
            ) : (
              <p className="muted">Nothing on this day.</p>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

/** A day's items grouped by kind. */
function DayItems({ items, now, onOpen }: { items: CalendarItem[]; now: number; onOpen?: () => void }) {
  return (
    <>
      {(['due', 'completed', 'worklog'] as const).map((k) => {
        const group = items.filter((i) => i.kind === k);
        if (!group.length) return null;
        return (
          <div key={k} className="day-group">
            <h4 className={cls('day-group-title', `cal-${k}`)}>{KIND_META[k].label}</h4>
            <ul className="day-items">
              {group.map((it, i) => (
                <li key={i}>
                  <CalendarChip item={it} now={now} onOpen={onOpen} />
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </>
  );
}

function CalendarChip({
  item,
  now,
  compact,
  onOpen,
}: {
  item: CalendarItem;
  now: number;
  compact?: boolean;
  onOpen?: () => void;
}) {
  const openCard = useOpenCard();
  const Icon = KIND_META[item.kind].icon;
  const overdue =
    item.kind === 'due' &&
    dueStatus({ dueDate: item.date, dueTime: item.time, completedAt: item.completed ? 'x' : null }, now) === 'overdue';
  const body = (
    <>
      <Icon size={compact ? 11 : 14} aria-hidden className="cal-icon" />
      {!compact && item.time && <span className="cal-time">{formatClock(item.time)}</span>}
      {item.priority && !compact && (
        <span className={cls('badge level-badge', `prio-badge-${item.priority}`)}>{PRIORITY_CODES[item.priority]}</span>
      )}
      <span className="cal-title">
        <TicketTitle ticketNo={item.ticketNo}>{item.title}</TicketTitle>
      </span>
      {!compact && item.kind === 'worklog' && item.bodyMd && <span className="cal-body">{item.bodyMd}</span>}
      {!compact && item.archived && <span className="muted small">archived</span>}
    </>
  );
  const className = cls('cal-chip', `cal-${item.kind}`, compact && 'is-compact', overdue && 'is-overdue', item.completed && item.kind === 'due' && 'is-done');
  if (compact) return <span className={className}>{body}</span>;
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        onOpen?.();
        openCard(item.cardId);
      }}
    >
      {body}
    </button>
  );
}

// A dropdown for priority / severity that shows every option with its colored badge (a native
// <select> can only color the chosen value). Keyboard: ↑/↓/Home/End move, Enter/Space picks,
// Esc closes; works the same with touch.

import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { cls } from '../../lib/cls';
import { Popover } from '../common/Popover';

export interface LevelOption<T extends string> {
  value: T;
  /** Short code shown in the badge: P0, S2… */
  code: string;
  /** Full name: "P0 Critical". */
  label: string;
  description?: string;
  /** CSS class that colors the badge. */
  badgeClass: string;
}

interface Props<T extends string> {
  value: T | null;
  options: LevelOption<T>[];
  onChange: (value: T | null) => void;
  /** Id of the visible label element. */
  labelledBy: string;
  disabled?: boolean;
}

export function LevelPicker<T extends string>({ value, options, onChange, labelledBy, disabled }: Props<T>) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value) ?? null;

  // Open with the chosen option focused.
  useEffect(() => {
    if (!anchor) return;
    const list = listRef.current;
    const target = list?.querySelector<HTMLElement>('[aria-selected="true"]') ?? list?.querySelector<HTMLElement>('[role="option"]');
    target?.focus({ preventScroll: true });
  }, [anchor]);

  function pick(v: T | null) {
    setAnchor(null);
    if (v !== value) onChange(v);
  }

  function onListKey(e: KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="option"]'));
    const i = items.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = Math.min(items.length - 1, i + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, i - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    if (next >= 0) {
      e.preventDefault();
      items[next]?.focus();
    }
  }

  const all: (LevelOption<T> | null)[] = [null, ...options];

  return (
    <>
      <button
        type="button"
        className="level-picker-btn input"
        aria-haspopup="listbox"
        aria-expanded={anchor !== null}
        aria-labelledby={labelledBy}
        disabled={disabled}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      >
        {current ? (
          <>
            <span className={cls('badge level-badge', current.badgeClass)}>{current.code}</span>
            <span className="level-picker-text">{current.label.slice(current.code.length + 1)}</span>
          </>
        ) : (
          <span className="level-picker-text muted">None</span>
        )}
        <ChevronDown size={16} aria-hidden className="level-picker-chevron" />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} className="level-popover" focus="panel">
          <div ref={listRef} role="listbox" aria-labelledby={labelledBy} onKeyDown={onListKey}>
            {all.map((o) => {
              const selected = (o?.value ?? null) === value;
              return (
                <div
                  key={o?.value ?? 'none'}
                  role="option"
                  aria-selected={selected}
                  tabIndex={-1}
                  className={cls('level-option', selected && 'is-selected')}
                  onClick={() => pick(o?.value ?? null)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      pick(o?.value ?? null);
                    }
                  }}
                >
                  {o ? (
                    <span className={cls('badge level-badge', o.badgeClass)}>{o.code}</span>
                  ) : (
                    <span className="badge level-badge level-badge-none">–</span>
                  )}
                  <span className="level-option-text">
                    <span className="level-option-label">{o ? o.label.slice(o.code.length + 1) : 'None'}</span>
                    {o?.description && <span className="level-option-desc">{o.description}</span>}
                  </span>
                  {selected && <Check size={16} aria-hidden className="level-option-check" />}
                </div>
              );
            })}
          </div>
        </Popover>
      )}
    </>
  );
}

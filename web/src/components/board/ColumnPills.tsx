import type { Column } from '@tt/shared';
import { useEffect, useRef } from 'react';
import { cls } from '../../lib/cls';
import { scrollBehavior } from '../../lib/useMediaQuery';

interface Props {
  columns: Column[];
  counts: number[];
  activeIndex: number;
  onSelect: (index: number) => void;
}

/**
 * Phone-only bar of column names + counts above the board (it doesn't scroll with it). Tapping a
 * pill scrolls that column into view; the pill of the column in view is highlighted.
 */
export function ColumnPills({ columns, counts, activeIndex, onSelect }: Props) {
  const navRef = useRef<HTMLElement>(null);

  // Keep the highlighted pill visible as the board scrolls (offsets are relative to the bar,
  // which is position: relative in CSS).
  useEffect(() => {
    const nav = navRef.current;
    const pill = nav?.children[activeIndex] as HTMLElement | undefined;
    if (!nav || !pill) return;
    const left = pill.offsetLeft;
    const right = left + pill.offsetWidth;
    if (left < nav.scrollLeft + 8 || right > nav.scrollLeft + nav.clientWidth - 8) {
      nav.scrollTo({ left: Math.max(0, left - 16), behavior: scrollBehavior() });
    }
  }, [activeIndex]);

  return (
    <nav ref={navRef} className="column-pills" aria-label="Jump to column">
      {columns.map((c, i) => {
        const n = counts[i] ?? 0;
        return (
          <button
            key={c.id}
            type="button"
            className={cls('pill', i === activeIndex && 'is-active')}
            aria-current={i === activeIndex ? 'true' : undefined}
            onClick={() => onSelect(i)}
          >
            <span className="pill-name">{c.name}</span>
            <span className="pill-count">
              {n}
              <span className="visually-hidden"> card{n === 1 ? '' : 's'}</span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}

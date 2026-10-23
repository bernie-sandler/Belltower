import { LABEL_COLORS } from '@tt/shared';
import { Check } from 'lucide-react';
import { useRef, type KeyboardEvent } from 'react';
import { cls } from '../../lib/cls';

interface Props {
  value: string;
  /** `via` tells a tap/click/Enter (a deliberate pick) from arrowing through the palette. */
  onChange: (hex: string, via: 'pointer' | 'keyboard') => void;
  label: string;
}

const KEYS: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * The fixed label palette as a radio group of swatches: one Tab stop (the selected swatch, or the
 * first), arrow keys move the selection like native radio buttons.
 */
export function ColorSwatches({ value, onChange, label }: Props) {
  const groupRef = useRef<HTMLDivElement>(null);
  const selectedIndex = LABEL_COLORS.findIndex((c) => c.hex === value);
  const tabIndexOf = (i: number) => (i === (selectedIndex >= 0 ? selectedIndex : 0) ? 0 : -1);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const delta = KEYS[e.key];
    let next: number | null = null;
    if (delta !== undefined) {
      const from = selectedIndex >= 0 ? selectedIndex : 0;
      next = (from + delta + LABEL_COLORS.length) % LABEL_COLORS.length;
    } else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = LABEL_COLORS.length - 1;
    if (next === null) return;
    e.preventDefault();
    onChange(LABEL_COLORS[next]!.hex, 'keyboard');
    groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  }

  return (
    <div ref={groupRef} className="swatches" role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {LABEL_COLORS.map((c, i) => {
        const selected = value === c.hex;
        return (
          <button
            key={c.hex}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={c.name}
            title={c.name}
            tabIndex={tabIndexOf(i)}
            className={cls('swatch', selected && 'is-selected')}
            style={{ backgroundColor: c.hex }}
            onClick={() => onChange(c.hex, 'pointer')}
          >
            {selected && <Check size={14} aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}

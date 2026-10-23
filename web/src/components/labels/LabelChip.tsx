import type { Label } from '@tt/shared';
import { cls } from '../../lib/cls';

/** WCAG relative luminance of '#rrggbb' (null for anything else). */
function luminance(hex: string): number | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// --on-color (#1d2125) has luminance ≈ 0.0144. Dark text wins whenever it gives the higher
// contrast; every color in LABEL_COLORS gets dark text at ≥ 5:1.
const DARK_TEXT_LUMINANCE = 0.0144;

/** True when white text reads better than the dark chip text on this background. */
export function needsLightText(hex: string): boolean {
  const l = luminance(hex);
  if (l === null) return false;
  const darkContrast = (l + 0.05) / (DARK_TEXT_LUMINANCE + 0.05);
  const lightContrast = 1.05 / (l + 0.05);
  return lightContrast > darkContrast;
}

/** Pill in the label's color; the name is always visible, in whichever text color contrasts best. */
export function LabelChip({ label, size = 'md' }: { label: Pick<Label, 'name' | 'color'>; size?: 'sm' | 'md' }) {
  return (
    <span
      className={cls('label-chip', size === 'sm' && 'label-chip-sm', needsLightText(label.color) && 'on-dark')}
      style={{ backgroundColor: label.color }}
      title={label.name}
    >
      {label.name}
    </span>
  );
}

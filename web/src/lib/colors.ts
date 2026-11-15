// Small sRGB helpers for the theme editor: parse what people type (hex or rgb()), mix colors, and
// measure WCAG contrast. Colors are stored as "#rrggbb" (lowercase).

export type Rgb = [number, number, number];

const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

/**
 * "#abc", "#aabbcc", "aabbcc", "rgb(1, 2, 3)", "rgb(1 2 3)" or "1, 2, 3" → "#rrggbb"; anything
 * else (including alpha) → null.
 */
export function parseColor(input: string): string | null {
  const s = input.trim().toLowerCase();
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (hex) {
    const h = hex[1]!;
    return `#${h.length === 3 ? [...h].map((c) => c + c).join('') : h}`;
  }
  const rgb = /^(?:rgb\(\s*)?(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*\)?$/.exec(s);
  if (rgb && (s.startsWith('rgb(') === s.endsWith(')'))) {
    const parts = [rgb[1], rgb[2], rgb[3]].map(Number);
    if (parts.every((n) => n <= 255)) return toHex(parts as Rgb);
  }
  return null;
}

export function toRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((c) => clamp(c).toString(16).padStart(2, '0')).join('')}`;
}

/** "rgb(1, 2, 3)" for display next to the hex. */
export function rgbText(hex: string): string {
  return `rgb(${toRgb(hex).join(', ')})`;
}

/** `amount` of `b` into `a` (0 = a, 1 = b). */
export function mix(a: string, b: string, amount: number): string {
  const x = toRgb(a);
  const y = toRgb(b);
  return toHex([0, 1, 2].map((i) => x[i]! + (y[i]! - x[i]!) * amount) as Rgb);
}

/** "rgba(r, g, b, alpha)". */
export function withAlpha(hex: string, alpha: number): string {
  return `rgba(${toRgb(hex).join(', ')}, ${alpha})`;
}

function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1–21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * `color`, moved toward black or white in small steps until it reaches `ratio` against every
 * background (or can't move further). Used for accent colors shown as text.
 */
export function readableOn(color: string, backgrounds: string[], ratio: number, toward: 'black' | 'white'): string {
  const target = toward === 'black' ? '#000000' : '#ffffff';
  for (let step = 0; step <= 20; step++) {
    const c = mix(color, target, step * 0.05);
    if (backgrounds.every((bg) => contrast(c, bg) >= ratio)) return c;
  }
  return target;
}

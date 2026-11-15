// Custom colors on top of the design tokens (styles/tokens.css), per device (localStorage
// `tt:custom-theme`), set in Settings → Appearance → Customize colors.
//
// Each mode (dark, light) has its own colors and corner radius. Only the roles below are editable;
// the tokens that hang off them (hover fills, accent colors used as text, input borders…) are
// derived here so one change carries through the app. Accent text colors are pushed toward black or
// white until they're readable (4.5:1) on every surface.
//
// The overrides go in a constructed stylesheet (document.adoptedStyleSheets): CSSOM isn't subject
// to the `style-src 'self'` CSP, which blocks a <style> element. The selectors mirror tokens.css
// with doubled :root so they win regardless of stylesheet order.

import { useSyncExternalStore } from 'react';
import { contrast, mix, parseColor, readableOn, withAlpha } from './colors';
import { refreshTheme, setHeaderColorSource } from './theme';

export type Mode = 'dark' | 'light';
export const MODES: readonly Mode[] = ['dark', 'light'];

export type RoleId =
  | 'bg'
  | 'header'
  | 'surface'
  | 'tile'
  | 'raised'
  | 'border'
  | 'textStrong'
  | 'text'
  | 'muted'
  | 'accent'
  | 'work'
  | 'danger'
  | 'warning'
  | 'success';

export type Palette = Record<RoleId, string>;

export interface Role {
  id: RoleId;
  label: string;
  token: string;
  group: 'Surfaces' | 'Text' | 'Accents';
}

export const ROLES: readonly Role[] = [
  { id: 'bg', label: 'Background', token: '--bg', group: 'Surfaces' },
  { id: 'header', label: 'Top bar', token: '--header-bg', group: 'Surfaces' },
  { id: 'surface', label: 'Columns', token: '--surface', group: 'Surfaces' },
  { id: 'tile', label: 'Cards & inputs', token: '--tile', group: 'Surfaces' },
  { id: 'raised', label: 'Menus & dialogs', token: '--raised', group: 'Surfaces' },
  { id: 'border', label: 'Borders', token: '--border', group: 'Surfaces' },
  { id: 'textStrong', label: 'Headings', token: '--text-strong', group: 'Text' },
  { id: 'text', label: 'Text', token: '--text', group: 'Text' },
  { id: 'muted', label: 'Muted text', token: '--muted', group: 'Text' },
  { id: 'accent', label: 'Accent', token: '--accent', group: 'Accents' },
  { id: 'work', label: 'Work cards', token: '--work', group: 'Accents' },
  { id: 'danger', label: 'Danger', token: '--danger', group: 'Accents' },
  { id: 'warning', label: 'Warning', token: '--warning', group: 'Accents' },
  { id: 'success', label: 'Success', token: '--success', group: 'Accents' },
];

const FILLS = { accent: '#579dff', work: '#9f8fef', danger: '#f87168', warning: '#f5cd47', success: '#4bce97' };

/** The built-in colors, as in tokens.css (a test keeps them in step). */
export const DEFAULTS: Record<Mode, Palette> = {
  dark: {
    bg: '#1d2125',
    header: '#161a1d',
    surface: '#101204',
    tile: '#22272b',
    raised: '#282e33',
    border: '#38414a',
    textStrong: '#dee4ea',
    text: '#b6c2cf',
    muted: '#9fadbc',
    ...FILLS,
  },
  light: {
    bg: '#f7f8f9',
    header: '#ffffff',
    surface: '#ebecf0',
    tile: '#ffffff',
    raised: '#ffffff',
    border: '#dcdfe4',
    textStrong: '#172b4d',
    text: '#44546f',
    muted: '#505f79',
    ...FILLS,
  },
};

/** Dark text on colored fills (buttons, badges): fixed, so fills must stay mid-tone or lighter. */
export const ON_COLOR = '#1d2125';

export type RadiusId = 'sharp' | 'default' | 'round';
export const RADII: Record<RadiusId, { label: string; sm: number; md: number; tile: number; col: number }> = {
  sharp: { label: 'Sharp', sm: 2, md: 4, tile: 4, col: 6 },
  default: { label: 'Default', sm: 4, md: 8, tile: 8, col: 12 },
  round: { label: 'Round', sm: 6, md: 12, tile: 12, col: 18 },
};

export interface ModeTheme {
  /** Only the roles that differ from DEFAULTS. */
  colors: Partial<Palette>;
  radius: RadiusId;
}
export type CustomTheme = Record<Mode, ModeTheme>;

export const EMPTY_THEME: CustomTheme = { dark: { colors: {}, radius: 'default' }, light: { colors: {}, radius: 'default' } };

// ---- presets ----

export interface Preset {
  id: string;
  name: string;
  description: string;
  radius: RadiusId;
  dark: Palette;
  light: Palette;
}

type Surfaces = Omit<Palette, keyof typeof FILLS>;
const preset = (
  id: string,
  name: string,
  description: string,
  radius: RadiusId,
  fills: typeof FILLS,
  dark: Surfaces,
  light: Surfaces,
): Preset => ({ id, name, description, radius, dark: { ...dark, ...fills }, light: { ...light, ...fills } });

export const PRESETS: readonly Preset[] = [
  { id: 'belltower', name: 'Belltower', description: 'The built-in look: cool gray-blue with a bright blue accent.', radius: 'default', ...DEFAULTS },
  preset(
    'slate',
    'Slate',
    'Quiet graphite, a teal accent and crisp corners.',
    'sharp',
    { accent: '#4fb8a8', work: '#a99be8', danger: '#ef7a72', warning: '#e8c35a', success: '#7ccf8f' },
    { bg: '#16191c', header: '#111315', surface: '#0d0f11', tile: '#1f2327', raised: '#252a2f', border: '#343a41', textStrong: '#eceff2', text: '#c3cad1', muted: '#9aa4ae' },
    { bg: '#f4f6f7', header: '#ffffff', surface: '#e6e9ec', tile: '#ffffff', raised: '#ffffff', border: '#d5dade', textStrong: '#1b252e', text: '#3d4a56', muted: '#56636f' },
  ),
  preset(
    'ember',
    'Ember',
    'Warm charcoal lit by one amber signal.',
    'default',
    { accent: '#e2a64b', work: '#c49be0', danger: '#e58a7a', warning: '#f0cf6a', success: '#93b283' },
    { bg: '#0e0d0b', header: '#0a0908', surface: '#151310', tile: '#1c1a16', raised: '#23201b', border: '#2f2b25', textStrong: '#f0ebe1', text: '#d9d3c7', muted: '#a39b8c' },
    { bg: '#f7f3ec', header: '#fffdf8', surface: '#ece5d9', tile: '#fffdf8', raised: '#fffdf8', border: '#ddd3c3', textStrong: '#241f17', text: '#4a4236', muted: '#6b6152' },
  ),
  preset(
    'forest',
    'Forest',
    'Deep pine greens with a moss accent and soft corners.',
    'round',
    { accent: '#7cc98f', work: '#b9a3e0', danger: '#ec8378', warning: '#e9c96b', success: '#5cc7b0' },
    { bg: '#121a16', header: '#0d1410', surface: '#0a100d', tile: '#1a241f', raised: '#202c26', border: '#2e3d35', textStrong: '#e6efe9', text: '#c4d3c9', muted: '#98aa9e' },
    { bg: '#f3f6f2', header: '#ffffff', surface: '#e3eae2', tile: '#ffffff', raised: '#ffffff', border: '#d2dcd3', textStrong: '#17251d', text: '#3a4a40', muted: '#52645a' },
  ),
  preset(
    'orchid',
    'Orchid',
    'Plum shadows, a violet accent and rounded edges.',
    'round',
    { accent: '#b48cf2', work: '#f093c3', danger: '#f27a8a', warning: '#f0c96a', success: '#6fd1a7' },
    { bg: '#17141d', header: '#120f17', surface: '#0e0c12', tile: '#201c28', raised: '#272231', border: '#382f45', textStrong: '#efeaf6', text: '#cdc5da', muted: '#a59cb5' },
    { bg: '#f7f4fa', header: '#ffffff', surface: '#ebe5f2', tile: '#ffffff', raised: '#ffffff', border: '#ddd4e8', textStrong: '#231b30', text: '#4a4058', muted: '#615673' },
  ),
  preset(
    'glacier',
    'Glacier',
    'Steel-blue surfaces and ice-blue light.',
    'default',
    { accent: '#6aa8f7', work: '#a99bf0', danger: '#f07b7b', warning: '#eecb63', success: '#5fcfa0' },
    { bg: '#10161d', header: '#0c1117', surface: '#0a0e13', tile: '#18212b', raised: '#1e2833', border: '#2b3846', textStrong: '#e9f0f7', text: '#c3d0dd', muted: '#97a7b8' },
    { bg: '#f2f6fa', header: '#ffffff', surface: '#e1e9f1', tile: '#ffffff', raised: '#ffffff', border: '#d0dbe6', textStrong: '#142233', text: '#3b4b5c', muted: '#536477' },
  ),
  preset(
    'parchment',
    'Parchment',
    'Espresso ink on old paper, with honey highlights.',
    'default',
    { accent: '#d9a95b', work: '#c7a0d8', danger: '#e08572', warning: '#ecc66b', success: '#9cc28a' },
    { bg: '#1a1512', header: '#14100d', surface: '#110d0b', tile: '#241d18', raised: '#2b231d', border: '#3b3129', textStrong: '#f3e9dc', text: '#dccfc0', muted: '#ab9c8b' },
    { bg: '#f5efe3', header: '#fbf7ee', surface: '#e9dfcd', tile: '#fbf7ee', raised: '#fbf7ee', border: '#dccfb9', textStrong: '#2a2017', text: '#4d4033', muted: '#6b5c4c' },
  ),
  preset(
    'contrast',
    'High contrast',
    'Pure black and white with strong borders, for bright rooms and tired eyes.',
    'sharp',
    { accent: '#66b3ff', work: '#c4a8ff', danger: '#ff8a80', warning: '#ffd84d', success: '#5ee0a0' },
    { bg: '#000000', header: '#000000', surface: '#0a0a0a', tile: '#141414', raised: '#1a1a1a', border: '#8a8a8a', textStrong: '#ffffff', text: '#f2f2f2', muted: '#cfcfcf' },
    { bg: '#ffffff', header: '#ffffff', surface: '#f0f0f0', tile: '#ffffff', raised: '#ffffff', border: '#6e6e6e', textStrong: '#000000', text: '#1a1a1a', muted: '#3d3d3d' },
  ),
];

// ---- pure helpers ----

export function effectivePalette(theme: ModeTheme, mode: Mode): Palette {
  return { ...DEFAULTS[mode], ...theme.colors };
}

/** Keeps only the colors that differ from the defaults. */
function diffFromDefaults(palette: Partial<Palette>, mode: Mode): Partial<Palette> {
  const out: Partial<Palette> = {};
  for (const role of ROLES) {
    const v = palette[role.id];
    if (v && v !== DEFAULTS[mode][role.id]) out[role.id] = v;
  }
  return out;
}

export function withColor(theme: ModeTheme, mode: Mode, role: RoleId, color: string | null): ModeTheme {
  const colors = { ...theme.colors };
  if (color === null) delete colors[role];
  else colors[role] = color;
  return { ...theme, colors: diffFromDefaults(colors, mode) };
}

export function withPreset(theme: ModeTheme, mode: Mode, p: Preset): ModeTheme {
  return { ...theme, colors: diffFromDefaults(p[mode], mode), radius: p.radius };
}

/** The preset this mode currently matches exactly, if any. */
export function matchingPreset(theme: ModeTheme, mode: Mode): Preset | null {
  const pal = effectivePalette(theme, mode);
  return PRESETS.find((p) => p.radius === theme.radius && ROLES.every((r) => p[mode][r.id] === pal[r.id])) ?? null;
}

/** The CSS variables for one mode: only those that change (none for an untouched mode). */
export function modeVariables(theme: ModeTheme, mode: Mode): Record<string, string> {
  const vars: Record<string, string> = {};
  const set = theme.colors;
  const p = effectivePalette(theme, mode);
  const dark = mode === 'dark';
  const changed = (...roles: RoleId[]) => roles.some((r) => r in set);
  const surfaces = [p.bg, p.surface, p.tile, p.raised];

  for (const role of ROLES) if (role.id in set) vars[role.token] = p[role.id];

  if (changed('tile', 'textStrong')) {
    vars['--tile-hover'] = mix(p.tile, p.textStrong, 0.07);
    vars['--input-bg'] = p.tile;
  }
  if (changed('raised', 'textStrong')) {
    vars['--raised-hover'] = mix(p.raised, p.textStrong, 0.08);
    vars['--toast-bg'] = dark ? mix(p.raised, p.textStrong, 0.05) : p.raised;
  }
  if (changed('surface')) vars['--placeholder'] = mix(p.surface, '#000000', dark ? 0.3 : 0.08);
  if (changed('bg')) vars['--drop-bg'] = withAlpha(p.bg, 0.9);
  if (changed('textStrong')) {
    vars['--btn-bg'] = withAlpha(p.textStrong, dark ? 0.08 : 0.06);
    vars['--btn-bg-hover'] = withAlpha(p.textStrong, dark ? 0.16 : 0.13);
  }
  if (changed('border', 'text')) {
    vars['--border-input'] = mix(p.border, p.text, 0.45);
    vars['--scrollbar'] = mix(p.border, p.text, 0.15);
  }

  // Accent fills: a lighter hover; as text, nudged until readable on every surface.
  const surfacesChanged = changed('bg', 'surface', 'tile', 'raised');
  const toward = dark ? 'white' : 'black';
  for (const name of ['accent', 'danger', 'success'] as const) {
    if (!changed(name) && !surfacesChanged) continue;
    const text = readableOn(p[name], surfaces, 4.5, toward);
    vars[`--${name}-text`] = text;
    vars[`--${name}-hover`] = mix(p[name], '#ffffff', 0.3);
    vars[`--${name}-strong`] = dark ? readableOn(mix(p[name], '#ffffff', 0.3), surfaces, 4.5, 'white') : text;
  }
  if (changed('warning') || surfacesChanged) vars['--warning-text'] = readableOn(p.warning, surfaces, 4.5, toward);
  if (changed('accent') || surfacesChanged) {
    vars['--focus'] = readableOn(dark ? mix(p.accent, '#ffffff', 0.3) : p.accent, surfaces, 3, toward);
    vars['--selection'] = withAlpha(p.accent, dark ? 0.35 : 0.3);
  }

  if (theme.radius !== 'default') {
    const r = RADII[theme.radius];
    vars['--radius-sm'] = `${r.sm}px`;
    vars['--radius-md'] = `${r.md}px`;
    vars['--radius-tile'] = `${r.tile}px`;
    vars['--radius-col'] = `${r.col}px`;
  }
  return vars;
}

/** The stylesheet for the whole theme ('' when nothing is customized). */
export function themeCss(theme: CustomTheme): string {
  const out: string[] = [];
  for (const mode of MODES) {
    const vars = modeVariables(theme[mode], mode);
    const body = Object.entries(vars)
      .map(([k, v]) => `${k}: ${v};`)
      .join(' ');
    if (!body) continue;
    out.push(`:root:root[data-theme='${mode}'] { ${body} }`);
    out.push(`@media (prefers-color-scheme: ${mode}) { :root:root:not([data-theme]) { ${body} } }`);
  }
  return out.join('\n');
}

export interface ContrastIssue {
  role: RoleId;
  on: RoleId;
  ratio: number;
}

/** Text roles that fall below 4.5:1 on a surface (the worst surface for each). */
export function contrastIssues(palette: Palette): ContrastIssue[] {
  const issues: ContrastIssue[] = [];
  for (const role of ['textStrong', 'text', 'muted'] as const) {
    let worst: ContrastIssue | null = null;
    for (const on of ['bg', 'surface', 'tile', 'raised'] as const) {
      const ratio = contrast(palette[role], palette[on]);
      if (ratio < 4.5 && (!worst || ratio < worst.ratio)) worst = { role, on, ratio };
    }
    if (worst) issues.push(worst);
  }
  for (const role of ['accent', 'work', 'danger', 'warning', 'success'] as const) {
    const ratio = contrast(ON_COLOR, palette[role]);
    if (ratio < 4.5) issues.push({ role, on: role, ratio });
  }
  return issues;
}

/** A stored theme, with anything unexpected dropped. */
export function parseStoredTheme(raw: string | null): CustomTheme {
  if (!raw) return EMPTY_THEME;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const out = { ...EMPTY_THEME };
    for (const mode of MODES) {
      const m = data[mode] as { colors?: Record<string, unknown>; radius?: unknown } | undefined;
      if (!m || typeof m !== 'object') continue;
      const colors: Partial<Palette> = {};
      for (const role of ROLES) {
        const v = m.colors?.[role.id];
        const c = typeof v === 'string' ? parseColor(v) : null;
        if (c) colors[role.id] = c;
      }
      const radius = typeof m.radius === 'string' && m.radius in RADII ? (m.radius as RadiusId) : 'default';
      out[mode] = { colors: diffFromDefaults(colors, mode), radius };
    }
    return out;
  } catch {
    return EMPTY_THEME;
  }
}

function isEmpty(theme: CustomTheme): boolean {
  return MODES.every((m) => Object.keys(theme[m].colors).length === 0 && theme[m].radius === 'default');
}

// ---- state ----

const KEY = 'tt:custom-theme';
const listeners = new Set<() => void>();
let sheet: CSSStyleSheet | null = null;

function read(): CustomTheme {
  try {
    return parseStoredTheme(localStorage.getItem(KEY));
  } catch {
    return EMPTY_THEME;
  }
}

let current: CustomTheme = read();

function apply(theme: CustomTheme): void {
  const css = themeCss(theme);
  try {
    if (!sheet) {
      if (!css) return;
      sheet = new CSSStyleSheet();
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    }
    sheet.replaceSync(css);
  } catch {
    /* an old browser without constructable stylesheets: the built-in colors stay */
  }
  refreshTheme();
}

/** Call once at startup, before the first render (after installTheme). */
export function installCustomTheme(): void {
  setHeaderColorSource((mode) => current[mode].colors.header ?? null);
  apply(current);
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    current = read();
    apply(current);
    for (const l of listeners) l();
  });
}

export function setCustomTheme(theme: CustomTheme): void {
  current = theme;
  try {
    if (isEmpty(theme)) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(theme));
  } catch {
    /* private mode: still applies for this visit */
  }
  apply(theme);
  for (const l of listeners) l();
}

export function useCustomTheme(): CustomTheme {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

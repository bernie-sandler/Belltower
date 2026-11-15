import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contrast } from './colors';
import {
  contrastIssues,
  DEFAULTS,
  EMPTY_THEME,
  matchingPreset,
  MODES,
  modeVariables,
  parseStoredTheme,
  PRESETS,
  ROLES,
  themeCss,
  withColor,
  withPreset,
  type Mode,
} from './customTheme';

const tokensCss = readFileSync(join(__dirname, '../styles/tokens.css'), 'utf8');

/** The `--name: value;` declarations in the first block that matches `selector`. */
function block(selector: string): Record<string, string> {
  const start = tokensCss.indexOf(selector);
  const body = tokensCss.slice(tokensCss.indexOf('{', start) + 1, tokensCss.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]!.trim()]));
}

describe('defaults', () => {
  it('match tokens.css', () => {
    const dark = block(':root {');
    const light = { ...dark, ...block(":root[data-theme='light'] {") };
    const css: Record<Mode, Record<string, string>> = { dark, light };
    for (const mode of MODES) {
      for (const role of ROLES) expect([mode, role.token, css[mode][role.token]]).toEqual([mode, role.token, DEFAULTS[mode][role.id]]);
    }
  });

  it('add nothing to the page when untouched', () => {
    expect(themeCss(EMPTY_THEME)).toBe('');
    expect(matchingPreset(EMPTY_THEME.dark, 'dark')?.id).toBe('belltower');
  });
});

describe('presets', () => {
  it.each(PRESETS.flatMap((p) => MODES.map((m) => [p.id, m, p] as const)))('%s (%s) is readable', (_id, mode, p) => {
    expect(contrastIssues(p[mode])).toEqual([]);
  });

  it('have unique ids, and applying one matches it', () => {
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
    for (const p of PRESETS) for (const mode of MODES) expect(matchingPreset(withPreset(EMPTY_THEME[mode], mode, p), mode)?.id).toBe(p.id);
  });
});

describe('editing', () => {
  it('keeps only real changes and drops a color set back to its default', () => {
    let t = withColor(EMPTY_THEME.dark, 'dark', 'accent', '#e2a64b');
    expect(t.colors).toEqual({ accent: '#e2a64b' });
    expect(matchingPreset(t, 'dark')).toBeNull();
    t = withColor(t, 'dark', 'accent', DEFAULTS.dark.accent);
    expect(t.colors).toEqual({});
    expect(withColor(withColor(EMPTY_THEME.dark, 'dark', 'bg', '#000000'), 'dark', 'bg', null).colors).toEqual({});
  });

  it('derives readable accent text and hover fills from one accent change', () => {
    const vars = modeVariables(withColor(EMPTY_THEME.light, 'light', 'accent', '#e2a64b'), 'light');
    expect(vars['--accent']).toBe('#e2a64b');
    for (const bg of [DEFAULTS.light.bg, DEFAULTS.light.tile, DEFAULTS.light.surface]) {
      expect(contrast(vars['--accent-text']!, bg)).toBeGreaterThanOrEqual(4.5);
    }
    expect(vars['--accent-hover']).toBeDefined();
    expect(vars['--bg']).toBeUndefined();
  });

  it('writes CSS for the chosen mode, both explicit and following the system', () => {
    const css = themeCss({ ...EMPTY_THEME, light: { colors: { bg: '#fafafa' }, radius: 'round' } });
    expect(css).toContain(":root:root[data-theme='light'] { --bg: #fafafa;");
    expect(css).toContain('@media (prefers-color-scheme: light) { :root:root:not([data-theme]) {');
    expect(css).toContain('--radius-md: 12px;');
    expect(css).not.toContain("data-theme='dark'");
  });

  it('flags text that is hard to read', () => {
    const issues = contrastIssues({ ...DEFAULTS.dark, muted: '#3a4048' });
    expect(issues).toEqual([expect.objectContaining({ role: 'muted' })]);
  });
});

describe('parseStoredTheme', () => {
  it('reads a saved theme and drops anything unexpected', () => {
    const raw = JSON.stringify({
      dark: { colors: { accent: 'E2A64B', bg: 'nope', bogus: '#ffffff', text: DEFAULTS.dark.text }, radius: 'round' },
      light: { radius: 'huge' },
    });
    expect(parseStoredTheme(raw)).toEqual({ dark: { colors: { accent: '#e2a64b' }, radius: 'round' }, light: { colors: {}, radius: 'default' } });
  });

  it('falls back to the defaults on junk', () => {
    expect(parseStoredTheme('{not json')).toEqual(EMPTY_THEME);
    expect(parseStoredTheme(null)).toEqual(EMPTY_THEME);
    expect(parseStoredTheme('42')).toEqual(EMPTY_THEME);
  });
});

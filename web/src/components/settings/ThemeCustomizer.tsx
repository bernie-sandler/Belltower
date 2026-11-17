// Main menu → Theme Customizer: System / Light / Dark, then presets and each color of one mode
// (dark or light), with a hex/RGB field, a color picker and a reset per color. Everything applies as
// you edit and is saved on this device (lib/theme.ts, lib/customTheme.ts). While it's open, the page
// shows the mode being edited.

import { AlertTriangle, Moon, RotateCcw, Sun } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { parseColor, rgbText } from '../../lib/colors';
import {
  contrastIssues,
  customThemeSupported,
  DEFAULTS,
  effectivePalette,
  matchingPreset,
  PRESETS,
  RADII,
  ROLES,
  setCustomTheme,
  useCustomTheme,
  withColor,
  withPreset,
  type Mode,
  type ModeTheme,
  type RadiusId,
  type Role,
  type RoleId,
} from '../../lib/customTheme';
import { previewMode, resolveMode, setTheme, shownMode, useTheme, type ThemeChoice } from '../../lib/theme';
import { Modal } from '../common/Modal';

const GROUPS = ['Surfaces', 'Text', 'Accents'] as const;
const CHOICES: [ThemeChoice, string][] = [
  ['system', 'System'],
  ['light', 'Light'],
  ['dark', 'Dark'],
];
const LABEL: Record<RoleId, string> = Object.fromEntries(ROLES.map((r) => [r.id, r.label])) as Record<RoleId, string>;

export function ThemeCustomizer({ onClose }: { onClose: () => void }) {
  const theme = useCustomTheme();
  const choice = useTheme();
  const inUse = resolveMode(choice);
  const [mode, setMode] = useState<Mode>(() => shownMode());

  // Show the mode being edited; back to the saved choice on close.
  useEffect(() => {
    if (customThemeSupported) previewMode(mode);
  }, [mode]);
  useEffect(() => () => previewMode(null), []);

  const mt = theme[mode];
  const update = (next: ModeTheme) => setCustomTheme({ ...theme, [mode]: next });
  const palette = effectivePalette(mt, mode);
  const active = matchingPreset(mt, mode);
  const issues = contrastIssues(palette);

  return (
    <Modal onClose={onClose} size="lg" title="Theme Customizer" className="theme-customizer">
      <div className="modal-body">
        <h4 className="theme-heading">Use</h4>
        <div className="theme-mode-row">
          <div className="segmented" role="radiogroup" aria-label="Theme">
            {CHOICES.map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={choice === value}
                className="segmented-item"
                onClick={() => {
                  setTheme(value);
                  setMode(resolveMode(value));
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="field-help">Saved on this device only. System follows your phone or computer’s light/dark setting.</p>
        </div>

        {customThemeSupported ? (
          <>
            <h4 className="theme-heading">Colors for</h4>
            <div className="theme-mode-row">
              <div className="segmented" role="radiogroup" aria-label="Mode to edit">
                {(['dark', 'light'] as const).map((m) => (
                  <button key={m} type="button" role="radio" aria-checked={mode === m} className="segmented-item" onClick={() => setMode(m)}>
                    {m === 'dark' ? <Moon size={14} aria-hidden /> : <Sun size={14} aria-hidden />} {m === 'dark' ? 'Dark' : 'Light'}
                    {m === inUse && <span className="theme-in-use">in use</span>}
                  </button>
                ))}
              </div>
              <p className="field-help">Each mode has its own colors. The page shows the mode you’re editing until you close this.</p>
            </div>

            <h4 className="theme-heading">Presets</h4>
            <div className="theme-presets" role="radiogroup" aria-label="Presets">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={active?.id === p.id}
                  className="theme-preset"
                  onClick={() => update(withPreset(mt, mode, p))}
                >
                  <span className="theme-preset-swatches" aria-hidden>
                    {(['bg', 'tile', 'accent', 'textStrong'] as const).map((r) => (
                      <span key={r} style={{ background: p[mode][r] }} />
                    ))}
                  </span>
                  <span className="theme-preset-name">{p.name}</span>
                  <span className="theme-preset-desc">{p.description}</span>
                  <span className="theme-preset-tag">{RADII[p.radius].label} corners</span>
                </button>
              ))}
            </div>
            {!active && <p className="field-help">Custom: your colors differ from every preset.</p>}

            <h4 className="theme-heading">Corners</h4>
            <div className="segmented" role="radiogroup" aria-label="Corners">
              {(Object.keys(RADII) as RadiusId[]).map((r) => (
                <button key={r} type="button" role="radio" aria-checked={mt.radius === r} className="segmented-item" onClick={() => update({ ...mt, radius: r })}>
                  {RADII[r].label}
                </button>
              ))}
            </div>

            {GROUPS.map((group) => (
              <section key={group} className="theme-group" aria-label={group}>
                <h4 className="theme-heading">{group}</h4>
                {ROLES.filter((r) => r.group === group).map((role) => (
                  <ColorRow
                    key={`${mode}-${role.id}`}
                    role={role}
                    value={palette[role.id]}
                    changed={role.id in mt.colors}
                    onChange={(c) => update(withColor(mt, mode, role.id, c))}
                  />
                ))}
              </section>
            ))}

            {issues.length > 0 && (
              <div className="notice notice-warning notice-row theme-issues" role="status">
                <AlertTriangle size={16} aria-hidden />
                <ul>
                  {issues.map((i) => (
                    <li key={i.role}>
                      {i.on === i.role
                        ? `Button text on ${LABEL[i.role]} is ${i.ratio.toFixed(1)}:1. Pick a lighter ${LABEL[i.role].toLowerCase()}.`
                        : `${LABEL[i.role]} on ${LABEL[i.on]} is ${i.ratio.toFixed(1)}:1, which is hard to read. Aim for 4.5:1.`}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : (
          <p className="field-help">This browser can’t apply custom colors. Light and dark still work.</p>
        )}
      </div>
      <footer className="modal-footer theme-footer">
        <p className="field-help">Saved on this device. Changes apply as you edit.</p>
        {customThemeSupported && (
          <button
            type="button"
            className="btn"
            disabled={Object.keys(mt.colors).length === 0 && mt.radius === 'default'}
            onClick={() => update({ colors: {}, radius: 'default' })}
          >
            <RotateCcw size={14} aria-hidden /> Reset {mode === 'dark' ? 'Dark' : 'Light'} colors
          </button>
        )}
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Done
        </button>
      </footer>
    </Modal>
  );
}

function ColorRow({ role, value, changed, onChange }: { role: Role; value: string; changed: boolean; onChange: (color: string | null) => void }) {
  const [draft, setDraft] = useState(value);
  const [invalid, setInvalid] = useState(false);
  const id = useId();

  // Follow changes from elsewhere (a preset, reset, the picker, another tab), but leave what the
  // person typed alone when it already means this color.
  useEffect(() => {
    setDraft((d) => (parseColor(d) === value ? d : value));
    setInvalid(false);
  }, [value]);

  const commit = (text: string) => {
    const c = parseColor(text);
    if (c) {
      if (c !== value) onChange(c);
      setDraft(c);
    }
    setInvalid(!c);
  };

  return (
    <div className="theme-row">
      <label className="theme-row-label" htmlFor={`${id}-text`}>
        {role.label} <code aria-hidden>{role.token}</code>
      </label>
      <input
        type="color"
        className="theme-picker"
        value={value}
        aria-label={`${role.label}: color picker`}
        onChange={(e) => onChange(e.target.value)}
      />
      <input
        id={`${id}-text`}
        className="input theme-hex"
        value={draft}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={invalid || undefined}
        aria-describedby={`${id}-help`}
        onChange={(e) => {
          setDraft(e.target.value);
          // Live only once the text can't grow into another color: "#1d2" is a valid short hex on
          // the way to "#1d2125", so shorthand and bare "r g b" wait for Enter or leaving the field.
          if (!COMPLETE.test(e.target.value.trim())) return;
          const c = parseColor(e.target.value);
          if (c && c !== value) onChange(c);
          if (c) setInvalid(false);
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(e.currentTarget.value);
        }}
      />
      <span id={`${id}-help`} className="visually-hidden">
        {invalid ? 'Not a color. Use #rrggbb or rgb(r, g, b).' : rgbText(value)}
      </span>
      <button
        type="button"
        className="icon-btn"
        aria-label={`Reset ${role.label}`}
        title={`Reset to ${DEFAULTS_HINT(role.id)}`}
        disabled={!changed}
        onClick={() => onChange(null)}
      >
        <RotateCcw size={14} aria-hidden />
      </button>
    </div>
  );
}

const COMPLETE = /^(#?[0-9a-f]{6}|rgb\(.*\))$/i;

const DEFAULTS_HINT = (role: RoleId) => `default (${DEFAULTS.dark[role]} dark, ${DEFAULTS.light[role]} light)`;

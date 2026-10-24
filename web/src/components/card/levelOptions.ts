// Options for the priority (P0–P3) and severity (S1–S4) pickers, shared by the card and Add ticket.

import {
  PRIORITIES,
  PRIORITY_CODES,
  PRIORITY_LABELS,
  SEVERITIES,
  SEVERITY_CODES,
  SEVERITY_DESCRIPTIONS,
  SEVERITY_LABELS,
  type Priority,
  type Severity,
} from '@tt/shared';
import type { LevelOption } from './LevelPicker';

export const PRIORITY_OPTIONS: LevelOption<Priority>[] = PRIORITIES.map((p) => ({
  value: p,
  code: PRIORITY_CODES[p],
  label: PRIORITY_LABELS[p],
  badgeClass: `prio-badge-${p}`,
}));

export const SEVERITY_OPTIONS: LevelOption<Severity>[] = SEVERITIES.map((v) => ({
  value: v,
  code: SEVERITY_CODES[v],
  label: SEVERITY_LABELS[v],
  description: SEVERITY_DESCRIPTIONS[v],
  badgeClass: `sev-badge-${v}`,
}));

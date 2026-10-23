import { getSetting, setSetting, stmt } from './connection';
import { addDays, addMonths, dayOfWeek, localDateOf, parseLocalDate, formatLocalDate } from '../lib/localdate';
import { nowIso, tx, type Ctx } from '../services/context';

const COLUMNS: { name: string; role: 'triage' | 'done' | null }[] = [
  { name: 'Triage', role: 'triage' },
  { name: 'Backlog', role: null },
  { name: 'In Progress', role: null },
  { name: 'Blocked/Waiting', role: null },
  { name: 'Done', role: 'done' },
];

const LABELS: { name: string; color: string }[] = [
  { name: 'Plex', color: '#f5cd47' },
  { name: 'Array/Storage', color: '#579dff' },
  { name: 'Network', color: '#6cc3e0' },
  { name: 'NPM/Proxy', color: '#f87168' },
  { name: 'VMs', color: '#9f8fef' },
  { name: 'Docker', color: '#4bce97' },
  { name: 'Hardware', color: '#fea362' },
  { name: 'Unraid OS', color: '#e774bb' },
];

interface SeedTemplate {
  title: string;
  description: string;
  priority: 'medium' | 'low';
  labels: string[];
  checklist: { title: string; items: string[] };
  unit: 'day' | 'week' | 'month';
  count: number;
  start: (today: string) => string;
  dueInDays: number;
}

const firstOfNextMonth = (today: string) => {
  const { y, m } = parseLocalDate(today);
  return addMonths(formatLocalDate({ y, m, d: 1 }), 1);
};

const TEMPLATES: SeedTemplate[] = [
  {
    title: 'Monthly parity check',
    description:
      'Run a parity check on the Unraid array and review the result.\n\n' +
      'Log the duration, average speed and sync error count in the work log.',
    priority: 'medium',
    labels: ['Array/Storage', 'Unraid OS'],
    checklist: {
      title: 'Parity check',
      items: [
        'Confirm no disks are disabled or emulated',
        'Run the parity check',
        'Record duration and average speed',
        'Confirm 0 sync errors (investigate if not)',
        'Check notifications/syslog for disk errors during the check',
      ],
    },
    unit: 'month',
    count: 1,
    start: firstOfNextMonth,
    dueInDays: 7,
  },
  {
    title: 'Monthly SMART review',
    description:
      'Review SMART data for every array, cache and pool disk.\n\n' +
      'Watch for changes in reallocated sectors, pending sectors, CRC errors and temperature.',
    priority: 'medium',
    labels: ['Array/Storage', 'Hardware'],
    checklist: {
      title: 'SMART review',
      items: [
        'Check SMART attributes for each disk',
        'Note reallocated / pending / offline-uncorrectable counts',
        'Note UDMA CRC error counts (cabling)',
        'Compare with last month',
        'Run an extended self-test on any suspect disk',
      ],
    },
    unit: 'month',
    count: 1,
    start: (today) => addDays(firstOfNextMonth(today), 14),
    dueInDays: 7,
  },
  {
    title: 'Weekly container & plugin update check',
    description: 'Check for Docker container and Unraid plugin updates, read release notes, and apply them.',
    priority: 'low',
    labels: ['Docker', 'Unraid OS'],
    checklist: {
      title: 'Updates',
      items: [
        'Check the Docker tab for container updates',
        'Check the Plugins tab for plugin updates',
        'Read release notes for anything major',
        'Apply updates',
        'Verify Plex and other key services are healthy',
      ],
    },
    unit: 'week',
    count: 1,
    // Next Sunday.
    start: (today) => addDays(today, 7 - dayOfWeek(today)),
    dueInDays: 3,
  },
];

/**
 * Seeds default columns, labels and (disabled) maintenance templates once. A `seeded` flag rather
 * than "table is empty" so deleting the defaults or restoring a backup never brings them back.
 */
export function seedDefaults(ctx: Ctx): boolean {
  if (getSetting(ctx.db, 'seeded')) return false;
  tx(ctx, () => {
    const now = nowIso(ctx);
    const db = ctx.db;
    COLUMNS.forEach((c, i) =>
      stmt(db, 'INSERT INTO columns (name, position, role, created_at) VALUES (?, ?, ?, ?)').run(c.name, i, c.role, now),
    );
    const labelIds = new Map<string, number>();
    LABELS.forEach((l, i) => {
      const info = stmt(db, 'INSERT INTO labels (name, color, position, created_at) VALUES (?, ?, ?, ?)').run(
        l.name,
        l.color,
        i,
        now,
      );
      labelIds.set(l.name, Number(info.lastInsertRowid));
    });

    const today = localDateOf(ctx.clock.now(), ctx.tz);
    for (const t of TEMPLATES) {
      const start = t.start(today);
      const info = stmt(
        db,
        `INSERT INTO recurring_templates (title, description_md, priority, checklist_template, interval_unit,
           interval_count, start_date, next_run_date, due_in_days, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      ).run(t.title, t.description, t.priority, JSON.stringify([t.checklist]), t.unit, t.count, start, start, t.dueInDays, now, now);
      const templateId = Number(info.lastInsertRowid);
      for (const name of t.labels) {
        const labelId = labelIds.get(name);
        if (labelId) {
          stmt(db, 'INSERT INTO recurring_template_labels (template_id, label_id) VALUES (?, ?)').run(templateId, labelId);
        }
      }
    }
    setSetting(db, 'seeded', '1');
    setSetting(db, 'app_tz_at_seed', ctx.tz);
  });
  return true;
}

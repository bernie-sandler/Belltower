// The demo's starting board. Built by replaying a few weeks of history through the same services
// the API uses, with the clock set back for each step, so ticket numbers, ages, the activity log,
// the calendar and "blocked" moves all come out the way a real install would show them.
//
// Mostly the owner's own tickets, with a few from other people through the submit page and two
// from recurring templates. Dates are relative to the moment the demo is seeded.

import { SubmitBody, type Priority, type Severity } from '@tt/shared';
import { archiveCard, completeCard, createCard, getCardRow, moveCard } from './server/cards';
import { updateChecklistItem } from './server/checklists';
import { emptyState, nextId, type Ctx, type DemoState } from './server/db';
import { parse } from './server/errors';
import { addDays, addMonths, dayOfWeek, formatLocalDate, localDateOf, parseLocalDate, zonedToInstant } from './server/lib';
import { createLink } from './server/links';
import { runTemplateNow } from './server/recurring';
import { createRequestType, newSubmitKey } from './server/settings';
import { submitTicket } from './server/submit';
import { addWorklog } from './server/worklog';

// ---- defaults, as server/src/db/seed.ts and services/requestTypes.ts create them ----

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

const firstOfNextMonth = (today: string) => {
  const { y, m } = parseLocalDate(today);
  return addMonths(formatLocalDate({ y, m, d: 1 }), 1);
};

const TEMPLATES = [
  {
    title: 'Monthly parity check',
    description:
      'Run a parity check on the Unraid array and review the result.\n\n' +
      'Log the duration, average speed and sync error count in the work log.',
    priority: 'medium' as Priority,
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
    unit: 'month' as const,
    start: firstOfNextMonth,
    dueInDays: 7,
  },
  {
    title: 'Monthly SMART review',
    description:
      'Review SMART data for every array, cache and pool disk.\n\n' +
      'Watch for changes in reallocated sectors, pending sectors, CRC errors and temperature.',
    priority: 'medium' as Priority,
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
    unit: 'month' as const,
    start: (today: string) => addDays(firstOfNextMonth(today), 14),
    dueInDays: 7,
  },
  {
    title: 'Weekly container & plugin update check',
    description: 'Check for Docker container and Unraid plugin updates, read release notes, and apply them.',
    priority: 'low' as Priority,
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
    unit: 'week' as const,
    start: (today: string) => addDays(today, 7 - dayOfWeek(today)),
    dueInDays: 3,
  },
];

const TRIED = { key: 'tried', label: 'What have you tried so far?', help: '', kind: 'long', required: false, options: [] as string[] } as const;
const STARTED = { key: 'started', label: 'When did it start?', help: '', kind: 'datetime', required: false, options: [] as string[] } as const;

const REQUEST_TYPES = [
  {
    name: 'General',
    description: 'A question, a request, or an idea',
    titlePattern: 'General – {summary}',
    fields: [
      {
        key: 'where',
        label: 'Where does this apply?',
        help: '',
        kind: 'choice',
        required: true,
        options: ['Game server', 'Media library (Plex)', 'Discord', 'Something else'],
      },
      { ...TRIED, label: 'Steps taken so far (if any)' },
      { key: 'extra', label: 'Anything else that might help?', help: '', kind: 'long', required: false, options: [] },
    ],
  },
  {
    name: 'Plex',
    description: 'Playback, missing episodes, subtitles, audio…',
    titlePattern: 'Plex – {title} – {summary}',
    typeLabel: 'Plex',
    fields: [
      { key: 'title', label: 'Movie or TV show', help: '', kind: 'short', required: true, options: [] },
      { key: 'media', label: 'Media type', help: '', kind: 'choice', required: true, options: ['Movie', 'TV show'] },
      { key: 'episode', label: 'Season and episode', help: 'For TV shows, e.g. S02E05', kind: 'short', required: false, options: [] },
      {
        key: 'device',
        label: 'Device or app',
        help: '',
        kind: 'choice',
        required: true,
        options: ['Plex on a computer', 'Plex in a web browser', 'Roku', 'Phone or tablet', 'Smart TV', 'Something else'],
      },
      STARTED,
      TRIED,
    ],
  },
  {
    name: 'Game servers',
    description: 'Lag, crashes, can’t connect, bans…',
    titlePattern: 'Game Servers – {game} – {summary}',
    fields: [
      { key: 'game', label: 'Game', help: '', kind: 'short', required: true, options: [] },
      { key: 'server', label: 'Server name', help: '', kind: 'short', required: false, options: [] },
      {
        key: 'issue',
        label: 'Issue type',
        help: '',
        kind: 'choice',
        required: true,
        options: ['Lag or performance', 'Crashes', 'Can’t connect', 'Server bug', 'Ban or appeal', 'Something else'],
      },
      STARTED,
      { ...TRIED, help: 'Restarted the game, cleared the cache, …' },
    ],
  },
] as const;

// ---- the sample board ----

/** [days ago, 'HH:MM' local time]. */
type When = [number, string];

interface SampleCard {
  ref: string;
  created: When;
  title: string;
  description?: string;
  column: string;
  labels?: string[];
  priority?: Priority;
  severity?: Severity;
  /** Days from today, with an optional time. */
  due?: number;
  dueTime?: string;
  kind?: 'work';
  partOf?: string;
  checklists?: { title: string; items: (string | { text: string; ticked: When })[] }[];
  worklog?: { text: string; at: When }[];
  blockedBy?: { ref: string; at: When }[];
  relatedTo?: { ref: string; at: When }[];
  done?: { at: When; reason: string; note?: string };
  archived?: When;
}

const SAMPLE_CARDS: SampleCard[] = [
  // ---- Triage ----
  {
    ref: 'cache',
    created: [0, '-3h'],
    title: 'Cache pool hit 90% overnight',
    description:
      'Got the warning at 6am. The mover ran fine, so something else is filling it.\n\n' +
      'Prime suspects: old appdata snapshots, or a download client that lost its share setting.',
    column: 'Triage',
    labels: ['Array/Storage', 'Docker'],
    priority: 'medium',
    severity: 'minor',
  },

  // ---- Backlog ----
  {
    ref: '10g',
    created: [12, '20:05'],
    kind: 'work',
    title: 'Move the rack to 10GbE',
    description: 'The 1GbE link is the bottleneck for backups and big file moves. Nothing urgent, so it happens in small steps.',
    column: 'Backlog',
    labels: ['Network'],
  },
  { ref: 'switch', created: [12, '20:07'], partOf: '10g', title: 'Pick a 10GbE switch', column: 'Backlog', labels: ['Network'], priority: 'medium', due: 14 },
  { ref: 'dac', created: [12, '20:08'], partOf: '10g', title: 'Order SFP+ DAC cables', column: 'Backlog', labels: ['Network', 'Hardware'], priority: 'low' },
  {
    ref: 'offsite',
    created: [19, '21:00'],
    title: 'Set up off-site backups for appdata',
    description: 'Everything is on one box in one house. If the house has a bad day, so does the data.',
    column: 'Backlog',
    labels: ['Array/Storage'],
    priority: 'medium',
    severity: 'minor',
    due: 21,
    checklists: [
      { title: 'Plan', items: ['Pick a storage provider', 'Run a first backup with restic', 'Schedule it nightly', 'Practice restoring one container'] },
    ],
  },
  {
    ref: 'ups-order',
    created: [4, '18:40'],
    title: 'Order a new UPS battery',
    description: 'The UPS started its replace-battery beep. Runtime is down to about four minutes.',
    column: 'Backlog',
    labels: ['Hardware'],
    priority: 'medium',
    severity: 'minor',
    due: 3,
  },
  {
    ref: 'patch',
    created: [16, '22:15'],
    title: 'Label the patch panel',
    description: "So the next network change doesn't start with unplugging cables to see what stops working.",
    column: 'Backlog',
    labels: ['Network'],
    priority: 'low',
    severity: 'trivial',
  },

  // ---- In Progress ----
  {
    ref: 'plex',
    created: [6, '19:00'],
    kind: 'work',
    title: 'Upgrade Plex',
    description: 'Moving to the new release with a safety net: back up first, test on a second container, then roll it out.',
    column: 'In Progress',
    labels: ['Plex'],
  },
  {
    ref: 'plex-backup',
    created: [6, '19:02'],
    partOf: 'plex',
    title: 'Back up the Plex database',
    column: 'In Progress',
    labels: ['Plex'],
    priority: 'high',
    done: { at: [2, '21:15'], reason: 'Fixed', note: 'Stopped the container, copied the database and `Preferences.xml` to the array, started it again.' },
  },
  {
    ref: 'hdr',
    created: [6, '19:03'],
    partOf: 'plex',
    title: 'Test HDR playback on the new version',
    column: 'In Progress',
    labels: ['Plex'],
    priority: 'medium',
    due: 4,
    checklists: [
      {
        title: 'Test plan',
        items: [
          { text: 'Start a second Plex container on a spare port', ticked: [2, '21:40'] },
          { text: 'Play a 4K HDR file on the TV', ticked: [1, '20:25'] },
          'Play it on a phone over Tailscale',
          'Check tone mapping on a remote stream',
        ],
      },
    ],
    worklog: [{ text: 'TV looks right. Direct play, no transcode. Phone test still to do.', at: [1, '20:30'] }],
  },
  {
    ref: 'plex-rollout',
    created: [6, '19:04'],
    partOf: 'plex',
    title: 'Roll the new version out to the server',
    column: 'In Progress',
    labels: ['Plex', 'Docker'],
    priority: 'medium',
    blockedBy: [{ ref: 'hdr', at: [6, '19:05'] }],
  },
  {
    ref: 'disk3',
    created: [7, '10:05'],
    title: 'Disk 3 reallocated sectors climbing',
    description:
      'Unraid flagged **reallocated sectors** on disk 3 after the last parity check, and the count keeps going up.\n\n' +
      'The data is safe for now: parity is valid and the disk is still in the array. The goal is to replace it ' +
      'before this turns into a rebuild under pressure.',
    column: 'In Progress',
    labels: ['Array/Storage', 'Hardware'],
    priority: 'high',
    severity: 'major',
    due: 2,
    dueTime: '18:00',
    checklists: [
      {
        title: 'Before replacing it',
        items: [
          { text: 'Run an extended SMART self-test', ticked: [3, '08:20'] },
          { text: 'Rule out the cable: swap the SATA port', ticked: [5, '20:00'] },
          { text: 'Open the warranty claim', ticked: [1, '19:10'] },
          'Preclear the replacement when it arrives',
        ],
      },
    ],
    worklog: [
      { text: 'Reallocated sectors went from 8 to 16 during the parity check. Pending still 0. Keeping an eye on it.', at: [6, '21:40'] },
      { text: "Up to 24 reallocated, 2 pending. SMART still says PASSED, which doesn't mean much. Started an extended self-test.", at: [3, '08:15'] },
      { text: 'Extended test failed at 62%. Still under warranty, so the claim is open.', at: [1, '19:05'] },
    ],
    relatedTo: [{ ref: 'parity', at: [7, '10:06'] }],
  },
  {
    ref: 'le',
    created: [5, '07:45'],
    title: "Let's Encrypt renewal failing in Nginx Proxy Manager",
    description:
      'Renewal fails for the `plex` and `requests` hosts. Certificates run out in six days, and phones start ' +
      'complaining after that.\n\n' +
      '```\nCertbot failed to authenticate some domains\nType: connection\nDetail: Timeout during connect (likely firewall problem)\n```',
    column: 'In Progress',
    labels: ['NPM/Proxy'],
    priority: 'critical',
    severity: 'major',
    due: -1,
    worklog: [{ text: 'Port 80 forward looks right from inside the LAN. Next: test from outside, phone on cellular.', at: [2, '22:10'] }],
  },

  // ---- Blocked/Waiting: these get there on their own, because something blocks them ----
  {
    ref: 'disk3-swap',
    created: [3, '08:30'],
    title: 'Swap disk 3 and rebuild from parity',
    column: 'Backlog',
    labels: ['Array/Storage', 'Hardware'],
    priority: 'high',
    severity: 'major',
    checklists: [{ title: 'Swap', items: ['Stop the array', 'Replace the drive', 'Assign it to slot 3 and start the rebuild', 'Run a parity check afterwards'] }],
    blockedBy: [{ ref: 'disk3', at: [3, '08:31'] }],
  },
  {
    ref: 'ups-swap',
    created: [4, '18:42'],
    title: 'Swap the UPS battery',
    column: 'Backlog',
    labels: ['Hardware'],
    priority: 'medium',
    blockedBy: [{ ref: 'ups-order', at: [4, '18:43'] }],
  },

  // ---- Done: each one says how it ended ----
  {
    ref: 'docker',
    created: [5, '18:50'],
    title: 'Docker image pulls failing with "no space left on device"',
    column: 'In Progress',
    labels: ['Docker'],
    priority: 'high',
    severity: 'major',
    worklog: [{ text: 'Plenty of room on the cache. `docker system df` shows the image itself is full.', at: [4, '19:20'] }],
    done: {
      at: [3, '20:05'],
      reason: 'Fixed',
      note: '`docker.img` had filled up because one container was logging to its own layer.\n\n- Turned on log rotation\n- Grew `docker.img` from 20 GB to 40 GB',
    },
  },
  {
    ref: 'pihole',
    created: [9, '07:30'],
    title: 'Pi-hole stops resolving after a router reboot',
    column: 'Backlog',
    labels: ['Network'],
    priority: 'medium',
    severity: 'major',
    done: { at: [5, '21:10'], reason: 'Fixed', note: 'The router handed the Pi-hole a new address after a firmware update. Gave it a static DHCP reservation.' },
  },

  // ---- Archived: off the board, but search still finds it ----
  {
    ref: 'bonding',
    created: [36, '23:10'],
    title: 'Web UI unreachable after changing the bonding mode',
    description: 'Changed the bonding mode over the network, and the server dropped off the network. No web UI, no SSH.',
    column: 'In Progress',
    labels: ['Network', 'Unraid OS'],
    priority: 'critical',
    severity: 'blocker',
    done: {
      at: [35, '10:00'],
      reason: 'Fixed',
      note:
        'Plugged in a monitor and keyboard, set the bonding mode back in `/boot/config/network.cfg` and rebooted.\n\n' +
        '**Next time:** change bonding from the console, not over the network.',
    },
    archived: [30, '09:00'],
  },
];

/** Tickets from other people, through the public submit page. */
const SUBMISSIONS: {
  ref: string;
  at: When;
  type: 'Plex' | 'Game servers' | 'General';
  body: { summary: string; description: string; name: string; answers: Record<string, string | string[] | boolean> };
  worklog?: { text: string; at: When }[];
  /** When the owner picked it up and moved it to In Progress. */
  started?: When;
  done?: { at: When; reason: string; note?: string };
}[] = [
  {
    ref: 'sam',
    at: [1, '21:14'],
    type: 'Plex',
    body: {
      summary: 'Audio drifts out of sync',
      description: 'It starts fine, then the voices are about a second behind by the end of the first scene.',
      name: 'Sam',
      answers: { title: 'The Long Harbor', media: 'Movie', device: 'Roku', tried: 'Restarted the Roku and the app.' },
    },
    worklog: [{ text: 'Asked Sam whether it happens with other movies too, or only this one.', at: [0, '-1h'] }],
  },
  {
    ref: 'priya',
    at: [1, '08:02'],
    type: 'Game servers',
    body: {
      summary: 'Can’t join since the update',
      description: 'Everyone in our group gets “connection timed out” since the game updated last night.',
      name: 'Priya',
      answers: { game: 'Valheim', server: 'Viking Nights', issue: 'Can’t connect' },
    },
  },
  {
    ref: 'jake',
    at: [14, '22:30'],
    type: 'Game servers',
    body: {
      summary: 'Random disconnects',
      description: 'Got kicked three times tonight, always around 10pm.',
      name: 'Jake',
      answers: { game: 'Minecraft', server: 'Survival', issue: 'Lag or performance', tried: 'Switched from Wi-Fi to a cable.' },
    },
    started: [13, '19:55'],
    worklog: [{ text: 'Watched the server all evening with Jake online: no drops, CPU and RAM fine.', at: [13, '22:40'] }],
    done: { at: [11, '20:00'], reason: 'Can’t reproduce', note: 'Two evenings of testing with no drops. Probably the ISP. Reopen if it comes back.' },
  },
];

export interface SeedOptions {
  /** Where the app is reached, for the submit page's link (the demo's base URL plus "#"). */
  appUrl?: string;
}

/** Builds a fresh demo board as of `now`, in `tz`. */
export function seedDemo(now: Date, tz: string, opts: SeedOptions = {}): DemoState {
  const s = emptyState(now.toISOString());
  let clock = now;
  const ctx: Ctx = { s, tz, now: () => clock };
  const today = localDateOf(now, tz);

  /** A local time `daysAgo` days back; '-3h' means that many hours before now. */
  const at = ([daysAgo, time]: When): Date => {
    const rel = /^-(\d+)h$/.exec(time);
    if (rel) return new Date(now.getTime() - Number(rel[1]) * 3_600_000);
    const t = zonedToInstant(addDays(today, -daysAgo), time, tz);
    // Never in the future (e.g. "today 20:30" seeded in the morning).
    return t.getTime() < now.getTime() ? t : new Date(now.getTime() - 60_000);
  };

  // ---- defaults ----
  const nowIso = now.toISOString();
  COLUMNS.forEach((c, i) => s.columns.push({ id: nextId(ctx, 'columns'), name: c.name, position: i, role: c.role, createdAt: nowIso }));
  LABELS.forEach((l, i) => s.labels.push({ id: nextId(ctx, 'labels'), name: l.name, color: l.color, position: i, createdAt: nowIso }));
  const column = (name: string) => s.columns.find((c) => c.name === name)!;
  const labelId = (name: string) => s.labels.find((l) => l.name === name)!.id;
  s.settings.blockedColumn = column('Blocked/Waiting').id;

  for (const t of TEMPLATES) {
    const start = t.start(today);
    s.templates.push({
      id: nextId(ctx, 'templates'),
      title: t.title,
      descriptionMd: t.description,
      priority: t.priority,
      checklists: [{ title: t.checklist.title, items: [...t.checklist.items] }],
      intervalUnit: t.unit,
      intervalCount: 1,
      startDate: start,
      nextRunDate: start,
      dueInDays: t.dueInDays,
      // The server seeds them paused; the demo turns them on, as an owner would.
      enabled: true,
      labelIds: t.labels.map(labelId),
      createdAt: nowIso,
      updatedAt: nowIso,
    });
  }
  for (const t of REQUEST_TYPES) {
    createRequestType(ctx, {
      name: t.name,
      description: t.description,
      titlePattern: t.titlePattern,
      fields: t.fields.map((f) => ({ ...f, options: [...f.options] })),
      tagLabelIds: [],
      typeLabelId: 'typeLabel' in t ? labelId(t.typeLabel) : null,
      enabled: true,
    });
  }
  s.settings.submit = {
    enabled: true,
    columnId: null,
    pageTitle: 'Ring the bell',
    intro: "Something not working? Tell me what happened and I'll take a look.",
    key: newSubmitKey(),
  };
  s.settings.general.appUrl = opts.appUrl ?? '';

  // ---- history, replayed in time order ----
  const ids = new Map<string, number>();
  const steps: { t: Date; order: number; run: () => void }[] = [];
  const step = (when: When, run: () => void) => steps.push({ t: at(when), order: steps.length, run });
  const done = (ref: string, d: { reason: string; note?: string }) =>
    completeCard(ctx, ids.get(ref)!, { includeChildren: false, resolution: { reason: d.reason, note: d.note ?? '' } });

  for (const c of SAMPLE_CARDS) {
    step(c.created, () => {
      const card = createCard(ctx, {
        title: c.title,
        description: c.description,
        columnId: column(c.column).id,
        labelIds: (c.labels ?? []).map(labelId),
        priority: c.priority ?? null,
        severity: c.severity ?? null,
        dueDate: c.due !== undefined ? addDays(today, c.due) : null,
        dueTime: c.dueTime ?? null,
        kind: c.kind ?? 'ticket',
        parentId: c.partOf ? ids.get(c.partOf)! : null,
        checklists: c.checklists?.map((l) => ({ title: l.title, items: l.items.map((i) => (typeof i === 'string' ? i : i.text)) })),
      });
      ids.set(c.ref, card.id);
    });
    c.checklists?.forEach((l) =>
      l.items.forEach((item) => {
        if (typeof item === 'string') return;
        step(item.ticked, () => {
          const it = s.checklistItems.find(
            (x) => x.text === item.text && s.checklists.some((cl) => cl.id === x.checklistId && cl.cardId === ids.get(c.ref)),
          )!;
          updateChecklistItem(ctx, it.id, { checked: true });
        });
      }),
    );
    for (const w of c.worklog ?? []) step(w.at, () => addWorklog(ctx, ids.get(c.ref)!, { bodyMd: w.text, occurredAt: clock.toISOString() }));
    for (const b of c.blockedBy ?? []) step(b.at, () => createLink(ctx, ids.get(c.ref)!, ids.get(b.ref)!, 'blocked_by'));
    for (const r of c.relatedTo ?? []) step(r.at, () => createLink(ctx, ids.get(c.ref)!, ids.get(r.ref)!, 'relates'));
    if (c.done) step(c.done.at, () => done(c.ref, c.done!));
    if (c.archived) step(c.archived, () => archiveCard(ctx, ids.get(c.ref)!));
  }

  for (const sub of SUBMISSIONS) {
    step(sub.at, () => {
      const type = s.requestTypes.find((t) => t.name === sub.type)!;
      const body = parse(SubmitBody, { typeId: type.id, ...sub.body });
      submitTicket(ctx, s.settings.submit.key!, body);
      ids.set(sub.ref, s.cards[s.cards.length - 1]!.id);
    });
    for (const w of sub.worklog ?? []) step(w.at, () => addWorklog(ctx, ids.get(sub.ref)!, { bodyMd: w.text, occurredAt: clock.toISOString() }));
    if (sub.started) {
      step(sub.started, () => moveCard(ctx, ids.get(sub.ref)!, { toColumnId: column('In Progress').id, afterCardId: null }));
    }
    if (sub.done) step(sub.done.at, () => done(sub.ref, sub.done!));
  }

  // Recurring templates: last week's parity check (done), and this week's update check (open).
  const template = (title: string) => s.templates.find((t) => t.title === title)!;
  step([8, '06:00'], () => ids.set('parity', runTemplateNow(ctx, template('Monthly parity check').id).id));
  step([7, '09:30'], () => {
    const card = getCardRow(ctx, ids.get('parity')!);
    for (const it of s.checklistItems.filter((i) => s.checklists.some((l) => l.id === i.checklistId && l.cardId === card.id))) {
      updateChecklistItem(ctx, it.id, { checked: true });
    }
    addWorklog(ctx, card.id, {
      bodyMd: 'Duration 19h 12m, average 116 MB/s, 0 sync errors. Disk 3 picked up more reallocated sectors, though.',
      occurredAt: clock.toISOString(),
    });
  });
  step([7, '09:45'], () => done('parity', { reason: 'Fixed' }));
  step([2, '07:00'], () => runTemplateNow(ctx, template('Weekly container & plugin update check').id));

  // The parity card is created by a step, so links to it have to wait until it exists.
  steps
    .sort((a, b) => a.t.getTime() - b.t.getTime() || a.order - b.order)
    .forEach((st) => {
      clock = st.t;
      st.run();
    });

  // A first-time visitor lands signed in, as the owner.
  s.session.signedIn = true;
  clock = now;
  return s;
}

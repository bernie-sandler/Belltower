// Fills a brand-new Belltower with sample tickets, through the same HTTP API the web app uses.
//
// docker-compose.yml in this folder runs it once in a throwaway container. It's plain Node with no
// dependencies, so the published image can run it as it is. Dates are worked out from today, so the
// board always looks current. A board that already has cards is left alone.
//
// Most of the board is one person's own tickets, because that's what most of Belltower's use is. A
// few arrive the other ways: the submit page, Uptime Kuma and a recurring template.

import { pathToFileURL } from 'node:url';

const CSRF = { 'X-Requested-With': 'tower-tracker' };

/** A checklist item that's already ticked. */
const ticked = (text) => ({ text, ticked: true });

const SMART_REPORT = `smartctl 7.4 (sample output for the Belltower demo)

Device Model:     Sample NAS Drive 8TB
Serial Number:    DEMO-DISK-0003
User Capacity:    8,001,563,222,016 bytes [8.00 TB]

ID# ATTRIBUTE_NAME          VALUE WORST THRESH TYPE      RAW_VALUE
  5 Reallocated_Sector_Ct   197   197   140    Pre-fail  24
  9 Power_On_Hours          041   041   000    Old_age   43112
194 Temperature_Celsius     117   104   000    Old_age   33
197 Current_Pending_Sector  200   200   000    Old_age   2
198 Offline_Uncorrectable   200   200   000    Old_age   0
199 UDMA_CRC_Error_Count    200   200   000    Old_age   0

SMART overall-health self-assessment test result: PASSED

Num  Test_Description    Status                  Remaining  LifeTime(hours)
# 1  Extended offline    Completed: read failure       38%            43109
`;

/**
 * The sample tickets, in the card import format (docs/CARD-IMPORT.md). `d(n)` is a date n days from
 * today and `t(n, 'HH:MM')` a time on that date. Three extras are handled here instead of by the
 * import: `completedDaysAgo`, `archive` and `attachment`, plus `ticked()` on checklist items.
 * Work-log times stay on yesterday or earlier, since the app refuses times in the future.
 */
function sampleCards(d, t) {
  return [
    // ---- Triage: just landed, not sorted yet (the submit page, Uptime Kuma and the recurring
    // template add theirs after these) ----
    {
      title: 'Cache pool hit 90% overnight',
      description:
        'Got the warning at 6am. The mover ran fine, so something else is filling it.\n\n' +
        'Prime suspects: old appdata snapshots, or a download client that lost its share setting.',
      column: 'Triage',
      labels: ['Array/Storage', 'Docker'],
      priority: 'P2',
      severity: 'S3',
    },

    // ---- Backlog: bigger jobs and things that can wait ----
    {
      type: 'work',
      title: 'Move the rack to 10GbE',
      description: 'The 1GbE link is the bottleneck for backups and big file moves. Nothing urgent, so it happens in small steps.',
      column: 'Backlog',
      labels: ['Network'],
      tickets: [
        { title: 'Pick a 10GbE switch', labels: ['Network'], priority: 'P2', due: d(14) },
        { title: 'Order SFP+ DAC cables', labels: ['Network', 'Hardware'], priority: 'P3' },
        {
          title: 'Swap the server NIC and test with iperf3',
          labels: ['Network', 'Hardware'],
          priority: 'P2',
          checklists: [
            {
              title: 'Swap day',
              items: ['Note the current network settings', 'Install the card', 'Check the link comes up at 10G', 'Run iperf3 both ways'],
            },
          ],
        },
      ],
    },
    {
      title: 'Set up off-site backups for appdata',
      description: 'Everything is on one box in one house. If the house has a bad day, so does the data.',
      column: 'Backlog',
      labels: ['Array/Storage'],
      priority: 'P2',
      severity: 'S3',
      due: d(21),
      checklists: [
        {
          title: 'Plan',
          items: ['Pick a storage provider', 'Run a first backup with restic', 'Schedule it nightly', 'Practice restoring one container'],
        },
      ],
    },
    {
      ref: 'ups-order',
      title: 'Order a new UPS battery',
      description: 'The UPS started its replace-battery beep. Runtime is down to about four minutes.',
      column: 'Backlog',
      labels: ['Hardware'],
      priority: 'P2',
      severity: 'S3',
      due: d(3),
    },
    {
      title: 'Clean up old Docker images and orphaned volumes',
      column: 'Backlog',
      labels: ['Docker'],
      priority: 'P3',
      severity: 'S4',
    },
    {
      title: 'Label the patch panel',
      description: 'So the next network change doesn\'t start with unplugging cables to see what stops working.',
      column: 'Backlog',
      labels: ['Network'],
      priority: 'P3',
      severity: 'S4',
    },

    // ---- In Progress: what's on the bench right now ----
    {
      type: 'work',
      title: 'Upgrade Plex',
      description: 'Moving to the new release with a safety net: back up first, test on a second container, then roll it out.',
      column: 'In Progress',
      labels: ['Plex'],
      tickets: [
        {
          title: 'Back up the Plex database',
          labels: ['Plex'],
          priority: 'P1',
          column: 'Done',
          resolution: {
            reason: 'Fixed',
            note: 'Stopped the container, copied the database and `Preferences.xml` to the array, started it again.',
          },
          completedDaysAgo: 2,
        },
        {
          ref: 'hdr-test',
          title: 'Test HDR playback on the new version',
          labels: ['Plex'],
          priority: 'P2',
          due: d(4),
          checklists: [
            {
              title: 'Test plan',
              items: [
                ticked('Start a second Plex container on a spare port'),
                ticked('Play a 4K HDR file on the TV'),
                'Play it on a phone over Tailscale',
                'Check tone mapping on a remote stream',
              ],
            },
          ],
          worklog: [{ text: 'TV looks right. Direct play, no transcode. Phone test still to do.', at: t(-1, '20:30') }],
        },
        {
          title: 'Roll the new version out to the server',
          column: 'Blocked/Waiting',
          labels: ['Plex', 'Docker'],
          priority: 'P2',
          blockedBy: 'hdr-test',
        },
      ],
    },
    {
      ref: 'disk3',
      title: 'Disk 3 reallocated sectors climbing',
      description:
        'Unraid flagged **reallocated sectors** on disk 3 after the last parity check, and the count keeps going up.\n\n' +
        'The data is safe for now: parity is valid and the disk is still in the array. The goal is to replace it ' +
        'before this turns into a rebuild under pressure.',
      column: 'In Progress',
      labels: ['Array/Storage', 'Hardware'],
      priority: 'P1',
      severity: 'S2',
      due: `${d(2)} 18:00`,
      checklists: [
        {
          title: 'Before replacing it',
          items: [
            ticked('Run an extended SMART self-test'),
            ticked('Rule out the cable: swap the SATA port'),
            ticked('Open the warranty claim'),
            'Preclear the replacement when it arrives',
          ],
        },
      ],
      worklog: [
        { text: 'Reallocated sectors went from 8 to 16 during the parity check. Pending still 0. Keeping an eye on it.', at: t(-6, '21:40') },
        { text: 'Up to 24 reallocated, 2 pending. SMART still says PASSED, which doesn\'t mean much. Started an extended self-test.', at: t(-3, '08:15') },
        { text: 'Extended test failed at 62%. Still under warranty, so the claim is open. Report attached.', at: t(-1, '19:05') },
      ],
      relatedTo: ['parity'],
      attachment: { name: 'disk3-smart.txt', text: SMART_REPORT },
    },
    {
      title: 'Let\'s Encrypt renewal failing in Nginx Proxy Manager',
      description:
        'Renewal fails for the `plex` and `requests` hosts. Certificates run out in six days, and phones start ' +
        'complaining after that.\n\n' +
        '```\nCertbot failed to authenticate some domains\nType: connection\nDetail: Timeout during connect (likely firewall problem)\n```',
      column: 'In Progress',
      labels: ['NPM/Proxy'],
      priority: 'P1',
      severity: 'S2',
      due: d(-1),
      worklog: [{ text: 'Port 80 forward looks right from inside the LAN. Next: test from outside, phone on cellular.', at: t(-2, '22:10') }],
    },
    {
      title: 'Windows VM loses its GPU after a reboot',
      description: 'Happens about one reboot in three. Force-stopping the VM and starting it again brings the GPU back.',
      column: 'In Progress',
      labels: ['VMs', 'Hardware'],
      priority: 'P3',
      severity: 'S3',
    },

    // ---- Blocked/Waiting: these land there on their own, because something blocks them ----
    {
      title: 'Swap disk 3 and rebuild from parity',
      column: 'Blocked/Waiting',
      labels: ['Array/Storage', 'Hardware'],
      priority: 'P1',
      severity: 'S2',
      blockedBy: 'disk3',
      checklists: [
        {
          title: 'Swap',
          items: ['Stop the array', 'Replace the drive', 'Assign it to slot 3 and start the rebuild', 'Run a parity check afterwards'],
        },
      ],
    },
    {
      ref: 'ups-swap',
      title: 'Swap the UPS battery',
      column: 'Blocked/Waiting',
      labels: ['Hardware'],
      priority: 'P2',
      blockedBy: 'ups-order',
    },
    {
      title: 'Calibrate UPS runtime',
      column: 'Blocked/Waiting',
      labels: ['Hardware'],
      priority: 'P3',
      blockedBy: 'ups-swap',
    },

    // ---- Done: each one says how it ended, so it's there to find the next time ----
    {
      title: 'Docker image pulls failing with "no space left on device"',
      column: 'Done',
      labels: ['Docker'],
      priority: 'P1',
      severity: 'S2',
      worklog: [{ text: 'Plenty of room on the cache. `docker system df` shows the image itself is full.', at: t(-4, '19:20') }],
      resolution: {
        reason: 'Fixed',
        note: '`docker.img` had filled up because one container was logging to its own layer.\n\n- Turned on log rotation\n- Grew `docker.img` from 20 GB to 40 GB',
      },
      completedDaysAgo: 3,
    },
    {
      title: 'Pi-hole stops resolving after a router reboot',
      column: 'Done',
      labels: ['Network'],
      priority: 'P2',
      severity: 'S2',
      resolution: {
        reason: 'Fixed',
        note: 'The router handed the Pi-hole a new address after a firmware update. Gave it a static DHCP reservation.',
      },
      completedDaysAgo: 5,
    },
    {
      title: 'Buy a bigger NVMe for the cache pool',
      column: 'Done',
      labels: ['Hardware', 'Array/Storage'],
      priority: 'P3',
      resolution: { reason: 'No longer needed', note: 'Clearing old appdata snapshots freed 300 GB. The current drive is fine for now.' },
      completedDaysAgo: 6,
    },
    {
      ref: 'parity',
      title: 'Monthly parity check',
      column: 'Done',
      labels: ['Array/Storage', 'Unraid OS'],
      priority: 'P2',
      worklog: [{ text: 'Duration 19h 12m, average 116 MB/s, 0 sync errors. Disk 3 picked up more reallocated sectors, though.', at: t(-7, '09:30') }],
      resolution: 'Fixed',
      completedDaysAgo: 7,
    },
    {
      title: 'Random disconnects on the game server',
      column: 'Done',
      labels: ['Network'],
      priority: 'P2',
      resolution: { reason: 'Can’t reproduce', note: 'Two evenings of testing with no drops. Probably the ISP. Reopen if it comes back.' },
      completedDaysAgo: 11,
    },

    // ---- Archived: off the board, but search still finds it ----
    {
      title: 'Web UI unreachable after changing the bonding mode',
      description: 'Changed the bonding mode over the network, and the server dropped off the network. No web UI, no SSH.',
      column: 'Done',
      labels: ['Network', 'Unraid OS'],
      priority: 'P1',
      severity: 'S1',
      resolution: {
        reason: 'Fixed',
        note: 'Plugged in a monitor and keyboard, set the bonding mode back in `/boot/config/network.cfg` and rebooted.\n\n**Next time:** change bonding from the console, not over the network.',
      },
      completedDaysAgo: 34,
      archive: true,
    },
  ];
}

/** Splits our extras off: returns what the import takes, and every card in the import's batch order. */
function forImport(cards) {
  const flat = [];
  const clean = (card) => {
    const { completedDaysAgo: _c, archive: _a, attachment: _f, ...rest } = card;
    flat.push(card);
    return {
      ...rest,
      ...(card.checklists && {
        checklists: card.checklists.map((c) => ({ title: c.title, items: c.items.map((i) => i.text ?? i) })),
      }),
      ...(card.tickets && { tickets: card.tickets.map(clean) }),
    };
  };
  return { cards: cards.map(clean), flat };
}

/** Today in the app's time zone, plus the helpers the sample data builds its dates with. */
function dateHelpers(now, timeZone) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const [y, m, day] = today.split('-').map(Number);
  const d = (offset) => new Date(Date.UTC(y, m - 1, day + offset)).toISOString().slice(0, 10);
  const t = (offset, time) => `${d(offset)} ${time}`;
  return { d, t };
}

function client(base) {
  let cookie = '';
  const send = async (method, path, { json, form, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...CSRF,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(json === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      ...(form === undefined ? {} : { body: form }),
    });
    if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}: ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  };
  return {
    send,
    async login(password) {
      const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { ...CSRF, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, remember: false }),
      });
      if (res.status !== 204) throw new Error(`Sign-in answered ${res.status}: ${await res.text()}`);
      cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    },
  };
}

async function waitForHealth(base, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`Belltower didn't answer at ${base} within ${timeoutMs / 1000} seconds`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** What the import can't express: ticked items, attachments, past completion dates, archiving. */
async function applyExtras(api, spec, id, now) {
  const wanted = (spec.checklists ?? []).flatMap((c) => c.items.filter((i) => i.ticked).map((i) => i.text));
  if (wanted.length) {
    const detail = await api.send('GET', `/api/cards/${id}`);
    const items = detail.checklists.flatMap((c) => c.items).filter((i) => wanted.includes(i.text));
    for (const item of items) await api.send('PATCH', `/api/checklist-items/${item.id}`, { json: { checked: true } });
  }
  if (spec.attachment) {
    const form = new FormData();
    form.append('file', new Blob([spec.attachment.text], { type: 'text/plain' }), spec.attachment.name);
    await api.send('POST', `/api/cards/${id}/attachments`, { form });
  }
  if (spec.completedDaysAgo !== undefined) {
    const { version } = await api.send('GET', `/api/cards/${id}`);
    const completedAt = new Date(now.getTime() - spec.completedDaysAgo * 86_400_000).toISOString();
    await api.send('PATCH', `/api/cards/${id}`, { json: { expectedVersion: version, completedAt } });
  }
  if (spec.archive) await api.send('POST', `/api/cards/${id}/archive`);
}

/** A ticket from someone else, through the public submit page (no sign-in, just its secret link). */
async function addSubmittedTicket(api) {
  const { submit } = await api.send('PUT', '/api/settings/submit', {
    json: {
      enabled: true,
      columnId: null,
      pageTitle: 'Ring the bell',
      intro: 'Something not working? Tell me what happened and I\'ll take a look.',
    },
  });
  const { types } = await api.send('GET', `/api/public/submit/${submit.key}`);
  const plex = types.find((type) => type.name === 'Plex');
  if (!plex) throw new Error('The default Plex request type is missing');
  const form = new FormData();
  form.append(
    'data',
    JSON.stringify({
      typeId: plex.id,
      summary: 'Audio drifts out of sync',
      description: 'It starts fine, then the voices are about a second behind by the end of the first scene.',
      answers: { title: 'The Long Harbor', media: 'Movie', device: 'Roku', tried: 'Restarted the Roku and the app.' },
      name: 'Sam',
    }),
  );
  await api.send('POST', `/api/public/submit/${submit.key}`, { form });
  return submit.key;
}

/** An alert from Uptime Kuma, sent twice: the repeat adds a note instead of a second ticket. */
async function addMonitoringTicket(api, t) {
  const { token } = await api.send('POST', '/api/tokens', { json: { name: 'Uptime Kuma', canComplete: true } });
  const alert = (time) => ({
    heartbeat: { status: 0, msg: 'connect ECONNREFUSED 192.168.1.60:8123', time },
    monitor: { id: 7, name: 'Home Assistant', url: 'http://192.168.1.60:8123' },
    msg: '[Home Assistant] [Down] connect ECONNREFUSED 192.168.1.60:8123',
  });
  for (const time of [t(-1, '23:41'), t(-1, '23:46')]) {
    await api.send('POST', '/api/v1/hooks/uptime-kuma?labels=Monitoring&priority=P1', {
      json: alert(time),
      headers: { Authorization: `Bearer ${token}` },
    });
  }
}

/** Puts every maintenance template on its schedule, with one ticket from the weekly one to show for it. */
async function startMaintenance(api) {
  const templates = await api.send('GET', '/api/templates');
  const weekly = templates.find((template) => template.title.startsWith('Weekly'));
  if (weekly) await api.send('POST', `/api/templates/${weekly.id}/run`);
  for (const template of templates) await api.send('PATCH', `/api/templates/${template.id}`, { json: { enabled: true } });
}

/**
 * Seeds the instance at `url`. Returns `{ skipped: true }` if it already has cards, otherwise the
 * number of cards imported, the submit page key and any warnings from the import.
 */
export async function seed({ url, password, now = new Date(), log = () => {} }) {
  await waitForHealth(url);
  const api = client(url);
  await api.login(password);

  const board = await api.send('GET', '/api/board');
  if (board.cards.length) {
    log(`This board already has ${board.cards.length} cards, so nothing was added.`);
    return { skipped: true };
  }

  const { timeZone } = await api.send('GET', '/api/config');
  const { d, t } = dateHelpers(now, timeZone);
  const { cards, flat } = forImport(sampleCards(d, t));
  const result = await api.send('POST', '/api/import/cards', {
    json: { data: { format: 'belltower/cards@1', cards }, dryRun: false },
  });
  const warnings = result.items.flatMap((item) => item.warnings.map((w) => `${item.label}: ${w}`));
  for (const w of warnings) log(`Warning from the import, card ${w}`);

  for (const [i, spec] of flat.entries()) await applyExtras(api, spec, result.created[i], now);

  const submitKey = await addSubmittedTicket(api);
  await addMonitoringTicket(api, t);
  await startMaintenance(api);

  return { skipped: false, imported: result.created.length, submitKey, warnings };
}

// Only when run directly, so the server's test can import this file and call seed() itself.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.BELLTOWER_URL;
  const password = process.env.APP_PASSWORD;
  if (!url || !password) {
    console.error('Set BELLTOWER_URL and APP_PASSWORD. docker-compose.yml in this folder does both.');
    process.exit(1);
  }
  const publicUrl = process.env.DEMO_PUBLIC_URL ?? url;
  try {
    const result = await seed({ url, password, log: console.log });
    if (!result.skipped) {
      console.log(`Added ${result.imported} sample tickets, plus one each from the submit page, Uptime Kuma and a recurring template.`);
      console.log(`Submit page: ${publicUrl}/submit/${result.submitKey}`);
    }
    console.log(`The demo is ready at ${publicUrl}`);
    console.log(`Password: ${password}`);
  } catch (err) {
    console.error(`Couldn't set up the demo: ${err.message}`);
    console.error('To start over: docker compose down -v && docker compose up -d');
    process.exit(1);
  }
}

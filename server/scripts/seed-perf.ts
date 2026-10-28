// A big board for performance checks: 20 work cards and 2,000 tickets with labels, priorities,
// checklists, work logs and blocking links, in a data folder of its own. Then it times the board
// and search the way the API builds them.
//
//   npm run seed:perf -w @tt/server -- <empty data folder>
//
// Start a server on that folder (DATA_DIR=<folder>) to try the UI with it. Never point it at real data.

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { SearchQuery } from '@tt/shared';
import { systemClock } from '../src/clock';
import { openDatabase } from '../src/db/connection';
import { migrate } from '../src/db/migrate';
import { prepareData } from '../src/db/prepare';
import { addChecklistItem, addChecklist } from '../src/services/checklists';
import { createCard, getBoard, moveCard } from '../src/services/cards';
import { tx, type Ctx } from '../src/services/context';
import { createLink } from '../src/services/links';
import { searchCards } from '../src/services/search';
import { addWorklog } from '../src/services/worklog';

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: npm run seed:perf -w @tt/server -- <empty data folder>');
  process.exit(1);
}
if (existsSync(dir) && readdirSync(dir).length) {
  console.error(`${dir} isn't empty. Use a new folder so real data is never touched.`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true });

const db = openDatabase(path.join(dir, 'tower.db'));
migrate(db);
const ctx: Ctx = { db, clock: systemClock, tz: process.env.TZ || 'America/Chicago' };
prepareData(ctx);

const WORK = 20;
const TICKETS = 2000;
const PRIORITIES = ['critical', 'high', 'medium', 'low', null] as const;
const SEVERITIES = ['blocker', 'major', 'minor', 'trivial', null] as const;
const THINGS = ['Plex', 'parity check', 'cache pool', 'Nextcloud', 'Tailscale', 'NPM proxy', 'UPS', 'disk 3', 'VM', 'backup job'];
const PROBLEMS = ['is slow', 'throws 502s', 'fails at night', 'shows CRC errors', 'needs an update', 'is out of space', 'keeps restarting'];

// mulberry32: repeatable runs, and evenly spread (unlike the low bits of a simple LCG).
let seed = 42;
const rand = (n: number) => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return Math.floor((((t ^ (t >>> 14)) >>> 0) / 2 ** 32) * n);
};
const pick = <T>(xs: readonly T[]) => xs[rand(xs.length)]!;

const started = Date.now();
const board0 = getBoard(ctx);
const columns = board0.columns.filter((c) => c.role !== 'done');
const done = board0.columns.find((c) => c.role === 'done')!;
const labelIds = board0.labels.map((l) => l.id);

tx(ctx, () => {
  const work = Array.from({ length: WORK }, (_, i) =>
    createCard(ctx, { title: `Project ${i + 1}: ${pick(THINGS)} overhaul`, kind: 'work', columnId: pick(columns).id }),
  );
  const ids: number[] = [];
  for (let i = 0; i < TICKETS; i++) {
    const card = createCard(ctx, {
      title: `${pick(THINGS)} ${pick(PROBLEMS)} (#${i + 1})`,
      description: `Seen on ${pick(THINGS)}. Logs attached in the work log.\n\n- step one\n- step two`,
      columnId: pick(columns).id,
      labelIds: [pick(labelIds), pick(labelIds)].filter((v, j, a) => a.indexOf(v) === j),
      priority: pick(PRIORITIES),
      severity: pick(SEVERITIES),
      dueDate: rand(4) === 0 ? `2026-1${rand(2)}-${String(1 + rand(28)).padStart(2, '0')}` : null,
      parentId: rand(3) === 0 ? pick(work).id : null,
    });
    ids.push(card.id);
    if (rand(4) === 0) {
      const list = addChecklist(ctx, card.id, 'Steps').checklists[0]!;
      for (let k = 0; k < 3; k++) addChecklistItem(ctx, list.id, `Step ${k + 1}`);
    }
    if (rand(3) === 0) addWorklog(ctx, card.id, { bodyMd: `Checked ${pick(THINGS)}; ${pick(PROBLEMS)} again.` });
  }
  // Some blocking links, then a quarter of the open tickets done (each move is a real move).
  for (let i = 0; i < 150; i++) {
    const a = pick(ids);
    const b = pick(ids);
    if (a !== b) {
      try {
        createLink(ctx, a, b, 'blocked_by');
      } catch {
        /* duplicate or a cycle: skip */
      }
    }
  }
  for (const id of ids) {
    if (rand(4) !== 0) continue;
    try {
      moveCard(ctx, id, { toColumnId: done.id, afterCardId: null });
    } catch {
      /* blocked: stays open */
    }
  }
});
console.log(`Seeded ${WORK} work cards and ${TICKETS} tickets in ${((Date.now() - started) / 1000).toFixed(1)} s → ${dir}`);

function time(label: string, fn: () => unknown, runs = 20) {
  fn(); // warm up
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  console.log(`${label}: median ${ms[Math.floor(runs / 2)]!.toFixed(1)} ms, worst ${ms[runs - 1]!.toFixed(1)} ms`);
}

time('GET /api/board (query + JSON)', () => JSON.stringify(getBoard(ctx)));
console.log(`  ${(JSON.stringify(getBoard(ctx)).length / 1024).toFixed(0)} KB of JSON, ${getBoard(ctx).cards.length} cards`);
time('Search "parity"', () => searchCards(ctx, SearchQuery.parse({ q: 'parity' })));
db.close();

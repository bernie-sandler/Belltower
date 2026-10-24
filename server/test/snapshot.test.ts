import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dailySnapshot } from '../src/services/backup';
import { createCard } from '../src/services/cards';
import { makeCtx } from './helpers';

let t: ReturnType<typeof makeCtx>;
beforeEach(() => {
  t = makeCtx();
});
afterEach(() => t.close());

describe('daily snapshot', () => {
  it('writes one consistent copy per day and keeps the last 7', async () => {
    createCard(t.ctx, { title: 'In the snapshot' });
    const dir = path.join(t.dir, 'backups');
    mkdirSync(dir, { recursive: true });
    for (let d = 1; d <= 8; d++) writeFileSync(path.join(dir, `tower-2026-09-0${d}.db`.replace('-0' + d + '.', d < 10 ? `-0${d}.` : `-${d}.`)), 'old');
    writeFileSync(path.join(dir, 'pre-restore-keep.db'), 'x');
    const file = await dailySnapshot(t.ctx, dir, '2026-10-10');
    expect(file).toMatch(/tower-2026-10-10\.db$/);
    expect(await dailySnapshot(t.ctx, dir, '2026-10-10')).toBeNull(); // once a day
    const kept = readdirSync(dir).filter((f) => /^tower-/.test(f)).sort();
    expect(kept).toHaveLength(7);
    expect(kept.at(-1)).toBe('tower-2026-10-10.db');
    expect(readdirSync(dir)).toContain('pre-restore-keep.db');
    const copy = new Database(file!, { readonly: true });
    expect(copy.prepare('SELECT title FROM cards').pluck().all()).toEqual(['In the snapshot']);
    copy.close();
  });
});

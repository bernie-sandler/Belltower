import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { client, makeApp, PASSWORD, sessionCookie, T0, type TestApp } from './helpers';

// demo/seed.mjs talks to the web app's API, which may change between versions, and the published
// image runs whatever is in that file. This runs it for real so a change that breaks the demo fails
// here instead of on someone trying Belltower for the first time.

interface SeedResult {
  skipped: boolean;
  imported?: number;
  submitKey?: string;
  warnings?: string[];
}
type Seed = (opts: { url: string; password: string; now: Date }) => Promise<SeedResult>;

describe('demo seed', () => {
  let t: TestApp;
  let seed: Seed;
  let url: string;
  let result: SeedResult;
  let api: ReturnType<typeof client>;

  beforeAll(async () => {
    seed = (await import(new URL('../../demo/seed.mjs', import.meta.url).href)).seed as Seed;
    t = await makeApp({ env: { APP_PASSWORD: PASSWORD } });
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    url = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
    result = await seed({ url, password: PASSWORD, now: new Date(T0) });
    const login = await client(t.app)('POST', '/api/auth/login', { password: PASSWORD, remember: false });
    api = client(t.app, sessionCookie(login));
  });

  afterAll(() => t.shutdown());

  const board = async () => (await api('GET', '/api/board')).json();
  const inColumn = async (name: string) => {
    const b = await board();
    const column = b.columns.find((c: { name: string }) => c.name === name);
    return b.cards.filter((c: { columnId: number }) => c.columnId === column.id);
  };
  const card = async (title: string) => {
    const found = (await board()).cards.find((c: { title: string }) => c.title.includes(title));
    expect(found, title).toBeTruthy();
    return (await api('GET', `/api/cards/${found.id}`)).json();
  };

  it('imports every sample card without a warning', () => {
    expect(result.skipped).toBe(false);
    expect(result.imported).toBeGreaterThan(20);
    expect(result.warnings).toEqual([]);
  });

  it('fills every column', async () => {
    for (const name of ['Triage', 'Backlog', 'In Progress', 'Blocked/Waiting', 'Done']) {
      expect((await inColumn(name)).length, name).toBeGreaterThan(2);
    }
  });

  it('adds tickets from the submit page, Uptime Kuma and a recurring template', async () => {
    const triage = (await inColumn('Triage')).map((c: { title: string }) => c.title);
    expect(triage).toContain('Plex – The Long Harbor – Audio drifts out of sync');
    expect(triage).toContain('Home Assistant is down');
    expect(triage).toContain('Weekly container & plugin update check');
    // The second alert adds a note instead of opening another ticket.
    expect(triage.filter((title: string) => title === 'Home Assistant is down')).toHaveLength(1);
  });

  it('turns on the submit page and the maintenance schedule', async () => {
    expect((await api('GET', `/api/public/submit/${result.submitKey}`)).statusCode).toBe(200);
    const templates = (await api('GET', '/api/templates')).json();
    expect(templates.length).toBeGreaterThan(0);
    expect(templates.every((x: { enabled: boolean }) => x.enabled)).toBe(true);
  });

  it('shows checklists part done, a work log and an attachment on the disk ticket', async () => {
    const disk = await card('Disk 3 reallocated');
    const items = disk.checklists[0].items as { checked: boolean }[];
    expect(items.filter((i) => i.checked)).toHaveLength(3);
    expect(items.filter((i) => !i.checked)).toHaveLength(1);
    expect(disk.attachments.map((a: { name: string; kind: string }) => [a.name, a.kind])).toEqual([['disk3-smart.txt', 'text']]);
    const activity = (await api('GET', `/api/cards/${disk.id}/activity`)).json();
    expect(activity.filter((e: { type: string }) => e.type === 'worklog')).toHaveLength(3);
  });

  it('files tickets under work cards, with a blocked one moved to Blocked/Waiting', async () => {
    const plex = await card('Upgrade Plex');
    expect(plex.kind).toBe('work');
    expect(plex.children).toHaveLength(3);
    const blocked = (await inColumn('Blocked/Waiting')) as { title: string; blockedBy: number }[];
    expect(blocked.map((c) => c.title)).toContain('Roll the new version out to the server');
    expect(blocked.every((c) => c.blockedBy > 0)).toBe(true);
  });

  it('dates finished tickets in the past and records how they ended', async () => {
    const done = (await inColumn('Done')) as { completedAt: string; resolution: string | null }[];
    expect(done.every((c) => c.resolution)).toBe(true);
    expect(done.every((c) => Date.parse(c.completedAt) < Date.parse(T0))).toBe(true);
  });

  it('keeps an archived ticket off the board but findable', async () => {
    expect((await inColumn('Done')).map((c: { title: string }) => c.title)).not.toContain(
      'Web UI unreachable after changing the bonding mode',
    );
    const hits = (await api('GET', '/api/search?q=bonding')).json();
    expect(hits.map((h: { title: string }) => h.title)).toContain('Web UI unreachable after changing the bonding mode');
  });

  it('leaves a board that already has cards alone', async () => {
    const before = (await board()).cards.length;
    expect((await seed({ url, password: PASSWORD, now: new Date(T0) })).skipped).toBe(true);
    expect((await board()).cards.length).toBe(before);
  });
});

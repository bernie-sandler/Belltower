import type { CardDetail } from '@tt/shared';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import yazl from 'yazl';
import { afterEach, describe, expect, it } from 'vitest';
import { client, makeApp, PASSWORD, sessionCookie, setupAndLogin, type TestApp } from './helpers';

function multipart(filename: string, content: Buffer) {
  const boundary = '----ttbackup' + Math.random().toString(16).slice(2);
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function upload(t: TestApp, cookie: string, url: string, filename: string, content: Buffer) {
  const m = multipart(filename, content);
  return t.app.inject({ method: 'POST', url, headers: { ...m.headers, cookie, 'x-requested-with': 'tower-tracker' }, payload: m.payload });
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 7)]);

/** A board with something in every table. */
async function populate(t: TestApp, cookie: string) {
  const api = client(t.app, cookie);
  const board = (await api('GET', '/api/board')).json();
  const done = board.columns.find((c: { role: string }) => c.role === 'done').id;
  const a = (await api('POST', '/api/cards', { title: 'Drive 3 CRC errors', description: '**cable?**', priority: 'high', severity: 'major', dueDate: '2026-10-20', dueTime: '18:00', labelIds: [board.labels[1].id] })).json() as CardDetail;
  const b = (await api('POST', '/api/cards', { title: 'Order replacement drive', columnId: done })).json() as CardDetail;
  let d = (await api('POST', `/api/cards/${a.id}/checklists`, { title: 'Steps' })).json() as CardDetail;
  d = (await api('POST', `/api/checklists/${d.checklists[0]!.id}/items`, { text: 'Reseat cable' })).json() as CardDetail;
  await api('PATCH', `/api/checklist-items/${d.checklists[0]!.items[0]!.id}`, { checked: true });
  await api('POST', `/api/cards/${a.id}/links`, { otherCardId: b.id, direction: 'blocked_by' });
  const w = (await api('POST', `/api/cards/${a.id}/worklog`, { bodyMd: 'Swapped cable' })).json();
  await api('PATCH', `/api/activity/${w.id}`, { bodyMd: 'Swapped SATA cable' });
  await upload(t, cookie, `/api/cards/${a.id}/attachments`, 'shot.png', PNG);
  await upload(t, cookie, `/api/cards/${a.id}/attachments`, 'syslog.log', Buffer.from('ata3 error\n'));
  await api('POST', `/api/cards/${b.id}/archive`);
  const tpl = (await api('GET', '/api/templates')).json()[0];
  await api('POST', `/api/templates/${tpl.id}/run`);
  await api('POST', '/api/labels', { name: 'Grafana', color: '#9f8fef' });
  return { a, b };
}

const strip = (data: { tables: Record<string, unknown[]> }) => {
  // Settings like app_tz_at_seed are installation metadata, but they round-trip too.
  return data.tables;
};

let apps: TestApp[] = [];
afterEach(async () => {
  for (const t of apps) await t.shutdown();
  apps = [];
});

describe('backup round trip', () => {
  it('exports to ZIP, restores into a fresh install, and exports identically', async () => {
    const src = await makeApp();
    apps.push(src);
    const srcCookie = await setupAndLogin(src);
    const { a } = await populate(src, srcCookie);
    const api = client(src.app, srcCookie);

    const json1 = (await api('GET', '/api/backup/export.json')).json();
    expect(json1).toMatchObject({ format: 'tower-tracker-backup', schemaVersion: 2, appTz: 'America/Chicago' });
    expect(json1.tables.sessions).toBeUndefined();
    expect(json1.tables.settings.some((s: { key: string }) => s.key === 'password_hash')).toBe(false);
    const zipRes = await api('GET', '/api/backup/export.zip');
    expect(zipRes.statusCode).toBe(200);
    expect(zipRes.headers['content-disposition']).toMatch(/tower-tracker-backup-\d{8}-\d{4}\.zip/);

    // A brand-new container with its own password.
    const dst = await makeApp();
    apps.push(dst);
    const dstCookie = await setupAndLogin(dst);
    const preview = await upload(dst, dstCookie, '/api/backup/restore', 'backup.zip', zipRes.rawPayload);
    expect(preview.statusCode).toBe(200);
    const p = preview.json();
    expect(p).toMatchObject({ withFiles: true, attachments: { expected: 2, present: 2, missing: 0 }, timeZoneWarning: null });
    expect(p.counts.cards).toBe(3);

    // Nothing changed yet.
    const dstApi = client(dst.app, dstCookie);
    expect((await dstApi('GET', '/api/board')).json().cards).toHaveLength(0);
    expect((await dstApi('POST', `/api/backup/restore/${p.token}/confirm`, { confirm: 'yes' })).statusCode).toBe(400);
    const done = await dstApi('POST', `/api/backup/restore/${p.token}/confirm`, { confirm: 'RESTORE' });
    expect(done.statusCode).toBe(200);

    // Still signed in with the destination's own session and password.
    const json2 = (await dstApi('GET', '/api/backup/export.json')).json();
    expect(strip(json2)).toEqual(strip(json1));
    expect((await client(dst.app)('POST', '/api/auth/login', { password: PASSWORD })).statusCode).toBe(204);

    // Attachments are byte-identical, and search works on the restored data.
    const card = (await dstApi('GET', `/api/cards/${a.id}`)).json() as CardDetail;
    const img = await dstApi('GET', `/api/attachments/${card.attachments[0]!.id}`);
    expect(img.rawPayload.equals(PNG)).toBe(true);
    expect((await dstApi('GET', '/api/search?q=sata')).json().map((r: { id: number }) => r.id)).toEqual([a.id]);
    // The previous (empty) database was kept.
    expect(readdirSync(path.join(dst.dir, 'backups')).some((f) => f.startsWith('pre-restore-'))).toBe(true);
    // Append-only guards are in place on the restored database.
    expect(() => dst.ctx.db.exec('DELETE FROM activity')).toThrow(/append-only/);
  });

  it('restores a JSON-only export and an older-schema export', async () => {
    const src = await makeApp();
    apps.push(src);
    const cookie = await setupAndLogin(src);
    const api = client(src.app, cookie);
    await api('POST', '/api/cards', { title: 'Old card', priority: 'low' });
    const json = (await api('GET', '/api/backup/export.json')).json();

    // Pretend it came from schema 1 (no severity column yet).
    json.schemaVersion = 1;
    for (const c of json.tables.cards) delete c.severity;

    const dst = await makeApp();
    apps.push(dst);
    const dstCookie = await setupAndLogin(dst);
    const p = (await upload(dst, dstCookie, '/api/backup/restore', 'b.json', Buffer.from(JSON.stringify(json)))).json();
    expect(p).toMatchObject({ withFiles: false, schemaVersion: 1 });
    const dstApi = client(dst.app, dstCookie);
    await dstApi('POST', `/api/backup/restore/${p.token}/confirm`, { confirm: 'RESTORE' });
    expect((await dstApi('GET', '/api/board')).json().cards).toMatchObject([{ title: 'Old card', priority: 'low', severity: null }]);
  });

  it('rejects bad uploads and leaves the live data alone', async () => {
    const t = await makeApp();
    apps.push(t);
    const cookie = await setupAndLogin(t);
    const api = client(t.app, cookie);
    await api('POST', '/api/cards', { title: 'Keep me' });
    const json = (await api('GET', '/api/backup/export.json')).json();

    const notBackup = await upload(t, cookie, '/api/backup/restore', 'x.json', Buffer.from('{"hello":1}'));
    expect(notBackup.statusCode).toBe(400);
    const garbage = await upload(t, cookie, '/api/backup/restore', 'x.zip', Buffer.from('PK\x03\x04garbage'));
    expect(garbage.statusCode).toBe(400);
    const newer = await upload(t, cookie, '/api/backup/restore', 'x.json', Buffer.from(JSON.stringify({ ...json, schemaVersion: 99 })));
    expect(newer.json().message).toMatch(/newer version/);
    const evil = structuredClone(json);
    evil.tables.cards[0].injected = 'x';
    expect((await upload(t, cookie, '/api/backup/restore', 'x.json', Buffer.from(JSON.stringify(evil)))).json().message).toMatch(/Unknown column/);
    const broken = structuredClone(json);
    broken.tables.cards[0].column_id = 999;
    expect((await upload(t, cookie, '/api/backup/restore', 'x.json', Buffer.from(JSON.stringify(broken)))).json().message).toMatch(/broken reference/);

    // A ZIP with path tricks: only the expected attachment paths are ever extracted.
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(JSON.stringify(json)), 'data.json');
    zip.addBuffer(Buffer.from('nope'), 'attachments/1/not-a-uuid');
    zip.addBuffer(Buffer.from('nope'), 'other/file.txt');
    zip.end();
    const chunks: Buffer[] = [];
    for await (const c of zip.outputStream) chunks.push(c as Buffer);
    const tricky = await upload(t, cookie, '/api/backup/restore', 'x.zip', Buffer.concat(chunks));
    // Unexpected entries are ignored (and yauzl refuses '..' paths outright).
    expect(tricky.statusCode).toBe(200);
    expect(readdirSync(t.dir).includes('evil.txt')).toBe(false);

    expect((await api('GET', '/api/board')).json().cards.map((c: { title: string }) => c.title)).toEqual(['Keep me']);
    expect(readdirSync(path.join(t.dir, 'tmp')).filter((f) => f.startsWith('upload-'))).toEqual([]);
  });

  it('requires a session to export', async () => {
    const t = await makeApp();
    apps.push(t);
    await setupAndLogin(t);
    expect((await t.app.inject({ method: 'GET', url: '/api/backup/export.json' })).statusCode).toBe(401);
    void sessionCookie;
    void readFileSync;
  });
});

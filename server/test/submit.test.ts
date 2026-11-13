import { CSRF_VALUE, GeneralSettingsBody, RequestTypeBody, SubmitBody, DiscordSettingsBody } from '@tt/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listActivity } from '../src/services/activity';
import { createCard, getCard } from '../src/services/cards';
import { createLabel, deleteLabel } from '../src/services/labels';
import {
  createRequestType,
  deleteRequestType,
  listRequestTypes,
  reorderRequestTypes,
  seedRequestTypes,
  updateRequestType,
} from '../src/services/requestTypes';
import {
  getSubmitSettings,
  regenerateSubmitKey,
  settingsResponse,
  updateDiscordSettings,
  updateGeneralSettings,
  updateSubmitSettings,
} from '../src/services/settings';
import { buildSubmission } from '../src/services/submit';
import { SUBMIT_LIMITS } from '../src/http/routes/submit';
import { client, columnId, makeApp, makeCtx, setupAndLogin, type TestApp } from './helpers';

let t: ReturnType<typeof makeCtx>;
beforeEach(() => {
  t = makeCtx();
});
afterEach(() => t.close());

const plex = () => listRequestTypes(t.ctx).find((x) => x.name === 'Plex')!;

describe('settings', () => {
  it('has defaults, and enabling the submit page gives it a secret address', () => {
    expect(getSubmitSettings(t.ctx)).toMatchObject({ enabled: false, key: null, columnId: null });
    updateSubmitSettings(t.ctx, { enabled: true, columnId: null, pageTitle: 'Help', intro: '' });
    const key = getSubmitSettings(t.ctx).key!;
    expect(key).toMatch(/^[\w-]{32}$/);
    // Turning it off and on keeps the address; "new link" replaces it.
    updateSubmitSettings(t.ctx, { enabled: false, columnId: null, pageTitle: 'Help', intro: '' });
    updateSubmitSettings(t.ctx, { enabled: true, columnId: null, pageTitle: 'Help', intro: '' });
    expect(getSubmitSettings(t.ctx).key).toBe(key);
    expect(regenerateSubmitKey(t.ctx)).not.toBe(key);
  });

  it('validates the ticket format, app URL and Discord webhook', () => {
    const ok = GeneralSettingsBody.safeParse({ ticketFormat: 'TT-{YYYY}{MM}{DD}-{N}', appUrl: 'https://tower.example/', claudeModel: '' });
    expect(ok.success && ok.data.appUrl).toBe('https://tower.example');
    for (const ticketFormat of ['{N}-{YY}', '{YY}{MM}', 'A%{N}', 'x_{N}', '{N}{N}']) {
      expect(GeneralSettingsBody.safeParse({ ticketFormat, appUrl: '', claudeModel: '' }).success).toBe(false);
    }
    const discord = (webhookUrl: string) =>
      DiscordSettingsBody.safeParse({ webhookUrl, events: { external: true, critical: true, digest: false, blocked: false }, digestTime: '08:00' })
        .success;
    expect(discord('https://discord.com/api/webhooks/123456/abc-DEF_123')).toBe(true);
    expect(discord('https://evil.example/api/webhooks/1/x')).toBe(false);
    expect(discord('http://discord.com/api/webhooks/1/x')).toBe(false);
  });

  it('never returns the webhook URL itself', () => {
    updateDiscordSettings(t.ctx, {
      webhookUrl: 'https://discord.com/api/webhooks/123456789/secretsecret',
      events: { external: true, critical: false, digest: false, blocked: false },
      digestTime: '08:00',
    });
    const s = settingsResponse(t.ctx, { modelFromEnv: null, enabled: false });
    expect(JSON.stringify(s)).not.toContain('secretsecret');
    expect(s.discord).toMatchObject({ webhookSet: true, webhookHint: 'https://discord.com/api/webhooks/1234…/secr…' });
    // null keeps it, '' removes it.
    updateDiscordSettings(t.ctx, { webhookUrl: null, events: s.discord.events, digestTime: '09:00' });
    expect(settingsResponse(t.ctx, { modelFromEnv: null, enabled: false }).discord.webhookSet).toBe(true);
    updateDiscordSettings(t.ctx, { webhookUrl: '', events: s.discord.events, digestTime: '09:00' });
    expect(settingsResponse(t.ctx, { modelFromEnv: null, enabled: false }).discord.webhookSet).toBe(false);
  });

  it('uses a custom ticket number format, keeping a counter per prefix', () => {
    expect(createCard(t.ctx, { title: 'Default' }).ticketNo).toBe('261010-1');
    updateGeneralSettings(t.ctx, { ticketFormat: 'TT-{YYYY}{MM}{DD}-{N}', appUrl: '', claudeModel: '' });
    expect(createCard(t.ctx, { title: 'A' }).ticketNo).toBe('TT-20261010-1');
    expect(createCard(t.ctx, { title: 'B' }).ticketNo).toBe('TT-20261010-2');
    updateGeneralSettings(t.ctx, { ticketFormat: '{YY}{MM}{DD}-{N}', appUrl: '', claudeModel: '' });
    expect(createCard(t.ctx, { title: 'C' }).ticketNo).toBe('261010-2');
  });
});

describe('request types', () => {
  it('seeds the three defaults once', () => {
    expect(listRequestTypes(t.ctx).map((x) => x.name)).toEqual(['General', 'Plex', 'Game servers']);
    expect(seedRequestTypes(t.ctx)).toBe(false);
    expect(plex().titlePattern).toBe('Plex – {title} – {summary}');
  });

  it('validates questions and the title pattern', () => {
    const base = { name: 'X', titlePattern: '{summary}', fields: [] };
    expect(RequestTypeBody.safeParse({ ...base, titlePattern: '{nope} – {summary}' }).success).toBe(false);
    expect(RequestTypeBody.safeParse({ ...base, fields: [{ key: 'a', label: 'A', kind: 'choice', options: ['one'] }] }).success).toBe(false);
    expect(
      RequestTypeBody.safeParse({ ...base, fields: [{ key: 'a', label: 'A', kind: 'short' }, { key: 'a', label: 'B', kind: 'short' }] }).success,
    ).toBe(false);
    expect(RequestTypeBody.safeParse({ ...base, fields: [{ key: 'summary', label: 'S', kind: 'short' }] }).success).toBe(false);
    expect(RequestTypeBody.safeParse({ ...base, fields: [{ key: 'Bad Key', label: 'S', kind: 'short' }] }).success).toBe(false);
  });

  it('seeds types without labels', () => {
    expect(listRequestTypes(t.ctx).map((x) => x.labelIds)).toEqual([[], [], []]);
  });

  it('creates, updates and reorders, with the labels every ticket gets', () => {
    const video = createLabel(t.ctx, 'Video', '#579dff');
    const audio = createLabel(t.ctx, 'Audio', '#4bce97');
    // In label order, once each.
    const created = createRequestType(t.ctx, RequestTypeBody.parse({ name: 'Network', labelIds: [audio.id, video.id, audio.id] }));
    expect(created.labelIds).toEqual([video.id, audio.id]);
    expect(updateRequestType(t.ctx, created.id, RequestTypeBody.parse({ name: 'Network', labelIds: [audio.id] })).labelIds).toEqual([audio.id]);
    // An unknown label changes nothing.
    expect(() => updateRequestType(t.ctx, created.id, RequestTypeBody.parse({ name: 'N', labelIds: [video.id, 9999] }))).toThrow(/Unknown label id 9999/);
    expect(listRequestTypes(t.ctx).find((x) => x.id === created.id)).toMatchObject({ name: 'Network', labelIds: [audio.id] });
    expect(() => createRequestType(t.ctx, RequestTypeBody.parse({ name: 'Bad', labelIds: [9999] }))).toThrow(/Unknown label/);
    expect(listRequestTypes(t.ctx).map((x) => x.name)).not.toContain('Bad');
    const ids = listRequestTypes(t.ctx).map((x) => x.id).reverse();
    expect(reorderRequestTypes(t.ctx, ids).map((x) => x.id)).toEqual(ids);
  });

  it('keeps the saved labels when an update leaves them out (a tab opened before 1.5.0-rc.4)', () => {
    const video = createLabel(t.ctx, 'Video', '#579dff');
    const created = createRequestType(t.ctx, RequestTypeBody.parse({ name: 'Network', labelIds: [video.id] }));
    // What 1.5's settings page sent: the old fields are dropped, labelIds is missing.
    const old = RequestTypeBody.parse({ name: 'Network', enabled: false, tagLabelIds: [], typeLabelId: null });
    expect(old).not.toHaveProperty('labelIds');
    expect(updateRequestType(t.ctx, created.id, old)).toMatchObject({ enabled: false, labelIds: [video.id] });
    expect(updateRequestType(t.ctx, created.id, RequestTypeBody.parse({ name: 'Network', labelIds: [] })).labelIds).toEqual([]);
    expect(createRequestType(t.ctx, RequestTypeBody.parse({ name: 'Bare' })).labelIds).toEqual([]);
  });

  it('drops a deleted label from every type, and a deleted type takes its labels with it', () => {
    const video = createLabel(t.ctx, 'Video', '#579dff');
    const audio = createLabel(t.ctx, 'Audio', '#4bce97');
    const created = createRequestType(t.ctx, RequestTypeBody.parse({ name: 'Network', labelIds: [video.id, audio.id] }));
    deleteLabel(t.ctx, video.id);
    expect(listRequestTypes(t.ctx).find((x) => x.id === created.id)!.labelIds).toEqual([audio.id]);
    deleteRequestType(t.ctx, created.id);
    expect(t.ctx.db.prepare('SELECT count(*) FROM request_type_labels').pluck().get()).toBe(0);
  });
});

describe('building a submission', () => {
  const body = (over: Partial<SubmitBody> = {}): SubmitBody =>
    SubmitBody.parse({
      typeId: 1,
      summary: 'stutters every few minutes',
      description: 'The movie freezes for a second.',
      answers: { title: 'Interstellar', media: 'Movie', device: 'Roku', started: '2026-10-28T19:30', tried: 'Restarted the Roku.' },
      name: 'Sam',
      ...over,
    });

  it('fills in the title pattern and appends the answers', () => {
    const { title, description } = buildSubmission(plex(), body());
    expect(title).toBe('Plex – Interstellar – stutters every few minutes');
    expect(description).toContain('The movie freezes for a second.');
    expect(description).toContain('### Plex details');
    expect(description).toContain('- **Media type:** Movie');
    expect(description).toContain('- **When did it start?** 2026-10-28 19:30');
    expect(description).toContain('**What have you tried so far?**\n\nRestarted the Roku.');
    expect(description).toContain('_Submitted by Sam through the submit page (Plex)._');
    expect(description).not.toContain('Season and episode'); // skipped optional question
  });

  it('drops the separator left by a skipped answer in the title', () => {
    const general = listRequestTypes(t.ctx).find((x) => x.name === 'Game servers')!;
    const b = body({ answers: { game: '', issue: 'Crashes' } as never });
    expect(() => buildSubmission(general, b)).toThrow(/Please answer “Game”/);
    const t2 = createRequestType(t.ctx, RequestTypeBody.parse({
      name: 'T',
      titlePattern: '{where} – {summary}',
      fields: [{ key: 'where', label: 'Where', kind: 'short' }],
    }));
    expect(buildSubmission(t2, body({ answers: {} })).title).toBe('stutters every few minutes');
  });

  it('rejects answers that aren’t allowed', () => {
    expect(() => buildSubmission(plex(), body({ answers: { title: 'X', media: 'Podcast', device: 'Roku' } }))).toThrow(/isn’t one of the choices/);
    expect(() => buildSubmission(plex(), body({ answers: { media: 'Movie', device: 'Roku' } }))).toThrow(/Please answer “Movie or TV show”/);
    expect(() => buildSubmission(plex(), body({ answers: { title: 'a\nb', media: 'Movie', device: 'Roku' } }))).toThrow(/one short line/);
    expect(() =>
      buildSubmission(plex(), body({ answers: { title: 'X', media: 'Movie', device: 'Roku', started: 'yesterday' } })),
    ).toThrow(/date and time/);
  });
});

// ---- HTTP ----

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

function multipart(data: unknown, files: { name: string; content: Buffer; type?: string }[] = []) {
  const boundary = `----tt${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="data"\r\n\r\n${JSON.stringify(data)}\r\n`),
  ];
  for (const f of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="screenshots"; filename="${f.name}"\r\nContent-Type: ${f.type ?? 'image/png'}\r\n\r\n`,
      ),
      f.content,
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-requested-with': CSRF_VALUE } };
}

describe('submit page over HTTP', () => {
  let app: TestApp;
  afterEach(() => app?.shutdown());

  async function openPage(columnName?: string) {
    app = await makeApp();
    await setupAndLogin(app);
    updateSubmitSettings(app.ctx, {
      enabled: true,
      columnId: columnName ? columnId(app.ctx, columnName) : null,
      pageTitle: 'Report a problem',
      intro: 'Hi',
    });
    return getSubmitSettings(app.ctx).key!;
  }

  const submission = (typeId: number, over: Record<string, unknown> = {}) => ({
    typeId,
    summary: 'stutters',
    description: 'Freezes',
    answers: { title: 'Interstellar', media: 'Movie', device: 'Roku' },
    ...over,
  });

  it('is 404 while off or with a wrong key, without needing a session', async () => {
    app = await makeApp();
    await setupAndLogin(app);
    expect((await app.app.inject({ method: 'GET', url: '/api/public/submit/whatever' })).statusCode).toBe(404);
    updateSubmitSettings(app.ctx, { enabled: true, columnId: null, pageTitle: 'P', intro: '' });
    expect((await app.app.inject({ method: 'GET', url: '/api/public/submit/wrong-key-wrong-key-wrong-key-xx' })).statusCode).toBe(404);
    const key = getSubmitSettings(app.ctx).key!;
    const res = await app.app.inject({ method: 'GET', url: `/api/public/submit/${key}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ pageTitle: 'P', maxFiles: 3 });
    expect(res.json().types.map((x: { name: string }) => x.name)).toEqual(['General', 'Plex', 'Game servers']);
  });

  it('never shows the page your labels', async () => {
    const key = await openPage();
    const video = createLabel(app.ctx, 'Video', '#579dff');
    const p = listRequestTypes(app.ctx).find((x) => x.name === 'Plex')!;
    updateRequestType(app.ctx, p.id, RequestTypeBody.parse({ ...p, labelIds: [video.id] }));
    const res = await app.app.inject({ method: 'GET', url: `/api/public/submit/${key}` });
    for (const type of res.json().types) expect(Object.keys(type).sort()).toEqual(['description', 'fields', 'id', 'name', 'titlePattern']);
    expect(res.body).not.toContain('Video');
  });

  it('files a ticket in the chosen column with the type’s labels, a screenshot and history', async () => {
    const key = await openPage('Backlog');
    const video = createLabel(app.ctx, 'Video', '#579dff');
    const audio = createLabel(app.ctx, 'Audio', '#4bce97');
    const other = createLabel(app.ctx, 'Other', '#f87168');
    const p = listRequestTypes(app.ctx).find((x) => x.name === 'Plex')!;
    updateRequestType(app.ctx, p.id, RequestTypeBody.parse({ ...p, labelIds: [video.id, audio.id] }));

    // A page opened before 1.5.0-rc.4 still sends picked tags: they're ignored.
    const res = await app.app.inject({
      method: 'POST',
      url: `/api/public/submit/${key}`,
      ...multipart(submission(p.id, { tagLabelIds: [other.id, 999], name: 'Sam' }), [{ name: 'shot.png', content: PNG }]),
    });
    expect(res.statusCode).toBe(201);
    const ticketNo = res.json().ticketNo as string;
    expect(ticketNo).toMatch(/^\d{6}-\d+$/);
    expect(res.json().statusPath).toMatch(/^\/submit\/status\/\d+\/[\w-]{22}$/);

    const id = app.ctx.db.prepare('SELECT id FROM cards WHERE ticket_no = ?').pluck().get(ticketNo) as number;
    const card = getCard(app.ctx, id);
    expect(card).toMatchObject({ title: 'Plex – Interstellar – stutters', columnId: columnId(app.ctx, 'Backlog') });
    expect([...card.labelIds].sort()).toEqual([video.id, audio.id].sort());
    expect(card.attachments.map((a) => a.kind)).toEqual(['image']);
    expect(listActivity(app.ctx, id).find((e) => e.type === 'created')!.data).toMatchObject({ via: 'submit page (Sam)', source: 'api' });
  });

  it('files a ticket without labels for a type that has none', async () => {
    const key = await openPage();
    const typeId = listRequestTypes(app.ctx)[1]!.id;
    const res = await app.app.inject({ method: 'POST', url: `/api/public/submit/${key}`, ...multipart(submission(typeId)) });
    expect(res.statusCode).toBe(201);
    const id = app.ctx.db.prepare('SELECT id FROM cards WHERE ticket_no = ?').pluck().get(res.json().ticketNo) as number;
    expect(getCard(app.ctx, id).labelIds).toEqual([]);
  });

  it('accepts only image screenshots, and pretends to accept bots', async () => {
    const key = await openPage();
    const typeId = listRequestTypes(app.ctx)[1]!.id;
    const bad = await app.app.inject({
      method: 'POST',
      url: `/api/public/submit/${key}`,
      ...multipart(submission(typeId), [{ name: 'run.exe', content: Buffer.from('MZ not an image'), type: 'application/octet-stream' }]),
    });
    expect(bad.statusCode).toBe(400);
    const bot = await app.app.inject({ method: 'POST', url: `/api/public/submit/${key}`, ...multipart(submission(typeId, { website: 'http://spam' })) });
    expect(bot.statusCode).toBe(201);
    expect(bot.json()).toEqual({ ticketNo: null, statusPath: null });
    expect(app.ctx.db.prepare('SELECT count(*) FROM cards').pluck().get()).toBe(0);
  });

  it('needs the CSRF header and limits how many tickets one address can file', async () => {
    const key = await openPage();
    const typeId = listRequestTypes(app.ctx)[1]!.id;
    const form = multipart(submission(typeId));
    const noCsrf = await app.app.inject({
      method: 'POST',
      url: `/api/public/submit/${key}`,
      payload: form.payload,
      headers: { 'content-type': form.headers['content-type'] },
    });
    expect(noCsrf.statusCode).toBe(403);

    for (let i = 0; i < SUBMIT_LIMITS.perClient.max; i++) {
      expect((await app.app.inject({ method: 'POST', url: `/api/public/submit/${key}`, ...multipart(submission(typeId)) })).statusCode).toBe(201);
    }
    const limited = await app.app.inject({ method: 'POST', url: `/api/public/submit/${key}`, ...multipart(submission(typeId)) });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });

  it('settings and request types need a session', async () => {
    app = await makeApp();
    await setupAndLogin(app);
    expect((await client(app.app)('GET', '/api/settings')).statusCode).toBe(401);
    expect((await client(app.app)('GET', '/api/request-types')).statusCode).toBe(401);
    expect((await client(app.app)('POST', '/api/tokens', { name: 'x' })).statusCode).toBe(401);
  });

  it('settings round trip over HTTP', async () => {
    app = await makeApp();
    const c = client(app.app, await setupAndLogin(app));
    const s = await c('PUT', '/api/settings/submit', { enabled: true, columnId: null, pageTitle: 'Help desk', intro: 'Hello' });
    expect(s.json().submit).toMatchObject({ enabled: true, pageTitle: 'Help desk' });
    expect(s.json().submit.key).toMatch(/^[\w-]{32}$/);
    const bad = await c('PUT', '/api/settings/general', { ticketFormat: 'nope', appUrl: '', claudeModel: '' });
    expect(bad.statusCode).toBe(400);
    const types = (await c('GET', '/api/request-types')).json();
    expect(types).toHaveLength(3);
  });
});

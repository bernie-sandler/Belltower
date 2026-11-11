// Settings → General → Teams: off by default. While it's off, the only notification written is
// `submitted` (a new submit-page ticket), to every active admin, in the app only; nothing goes to
// personal channels, and the bell lists only those. Assignments, watchers and old notifications
// are kept, so turning Teams back on brings everything back.

import { DEFAULT_NOTIFY_PREFS, SubmitBody, type NotifyPrefs } from '@tt/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareData } from '../src/db/prepare';
import { openDatabase } from '../src/db/connection';
import { buildRestoreDb, exportData } from '../src/services/backup';
import { createCard, getCard, moveCard, updateCard } from '../src/services/cards';
import { withActor, type AppEvent, type Ctx } from '../src/services/context';
import { intakeCard } from '../src/services/intake';
import {
  listNotifications,
  markNotificationsRead,
  notifyPeople,
  personalNotifySettings,
  updatePersonalNotify,
  watchCard,
} from '../src/services/notifications';
import { addWorklog, updateWorklog } from '../src/services/worklog';
import { Notifier } from '../src/services/notify';
import { listRequestTypes } from '../src/services/requestTypes';
import {
  backfillTeamsSetting,
  getSubmitSettings,
  getTeamsSettings,
  teamsEnabled,
  updateChannelSettings,
  updateDiscordSettings,
  updateSubmitSettings,
  updateTeamsSettings,
} from '../src/services/settings';
import { submitTicket } from '../src/services/submit';
import { createToken } from '../src/services/tokens';
import { createUser } from '../src/services/users';
import { addPerson, client, columnId, makeApp, makeCtx, setupAndLogin, type TestApp } from './helpers';

let t: ReturnType<typeof makeCtx>;
let events: AppEvent[];
const people: Record<string, number> = {};

const everywhere = { inApp: true, discord: true, ntfy: true };
const nowhere = { inApp: false, discord: false, ntfy: false };
const inApp = { inApp: true, discord: false, ntfy: false };

function person(username: string, role: 'admin' | 'member', prefs?: Partial<NotifyPrefs>): number {
  const displayName = username[0]!.toUpperCase() + username.slice(1);
  const id = createUser(t.ctx, { username, displayName, role }, 'not-a-real-hash').id;
  if (prefs) setPrefs(username, prefs, id);
  people[username] = id;
  return id;
}

/** Saves prefs as an older version would: only the events given (the rest take the defaults). */
function setPrefs(username: string, prefs: Partial<NotifyPrefs>, id = people[username]!) {
  t.ctx.db.prepare('UPDATE users SET notify_prefs = ? WHERE id = ?').run(JSON.stringify(prefs), id);
}

const as = (name: string): Ctx => withActor(t.ctx, { kind: 'user', userId: people[name]! });
const teams = (enabled: boolean) => updateTeamsSettings(t.ctx, { enabled });

/** Every notification row someone has, bell or not: "type" or "type (hidden)". */
const rows = (name: string) =>
  (t.ctx.db.prepare('SELECT type, data FROM notifications WHERE user_id = ? ORDER BY id').all(people[name]!) as { type: string; data: string }[]).map(
    (r) => (JSON.parse(r.data).hidden ? `${r.type} (hidden)` : r.type),
  );
/** What the bell shows someone: "type: text", newest first. */
const bell = (name: string) => listNotifications(t.ctx, people[name]!, { limit: 100 }).items.map((n) => `${n.type}: ${n.text}`);
const unread = (name: string) => listNotifications(t.ctx, people[name]!, { limit: 1 }).unread;
const watchers = (cardId: number) =>
  t.ctx.db.prepare('SELECT u.username FROM card_watchers w JOIN users u ON u.id = w.user_id WHERE card_id = ? ORDER BY u.username').pluck().all(cardId) as string[];
const teamsRow = (db = t.ctx.db) => db.prepare(`SELECT value FROM settings WHERE key = 'teams_settings'`).pluck().get() as string | undefined;

/** A ticket through the submit page, as someone without an account sends it. Returns the card id. */
function submit(name = 'Sam'): number {
  if (!getSubmitSettings(t.ctx).enabled) updateSubmitSettings(t.ctx, { enabled: true, columnId: null, pageTitle: 'Report a problem', intro: '' });
  const plex = listRequestTypes(t.ctx).find((x) => x.name === 'Plex')!;
  const body = SubmitBody.parse({ typeId: plex.id, summary: 'stutters', description: 'Freezes', answers: { title: 'Up', media: 'Movie', device: 'Roku' }, name });
  const res = submitTicket(withActor(t.ctx, { kind: 'public' }), getSubmitSettings(t.ctx).key!, body, [], t.dir);
  return t.ctx.db.prepare('SELECT id FROM cards WHERE ticket_no = ?').pluck().get(res.ticketNo) as number;
}

/** A ticket from a monitor, through an API token of the owner's. */
function fromMonitor(title: string): number {
  const { info } = createToken(as('owner'), { name: 'Kuma', canComplete: false });
  const kuma = withActor(t.ctx, { kind: 'token', tokenId: info.id, userId: people.owner! });
  return intakeCard(kuma, { id: info.id, name: 'Kuma', canComplete: false, scope: 'full', userId: people.owner! }, { title }).card!.id;
}

beforeEach(() => {
  t = makeCtx();
  events = [];
  t.ctx.emit = (e) => events.push(e);
  for (const k of Object.keys(people)) delete people[k];
  person('owner', 'admin');
  person('alex', 'admin');
  person('jordan', 'member');
});
afterEach(() => t.close());

describe('the setting', () => {
  it('is off by default, and anything but true reads as off (a restored backup isn’t validated)', () => {
    expect(getTeamsSettings(t.ctx)).toEqual({ enabled: false });
    teams(true);
    expect(teamsEnabled(t.ctx)).toBe(true);
    t.ctx.db.prepare(`UPDATE settings SET value = '{"enabled":"yes"}' WHERE key = 'teams_settings'`).run();
    expect(teamsEnabled(t.ctx)).toBe(false);
    t.ctx.db.prepare(`UPDATE settings SET value = 'not json' WHERE key = 'teams_settings'`).run();
    expect(teamsEnabled(t.ctx)).toBe(false);
  });

  it('gets its first value once at startup: on only where more than one person is already active', () => {
    // As if this database came from before the setting existed: owner, Alex and Jordan are active.
    expect(teamsRow()).toBe('{"enabled":false}'); // makeCtx sets up a new install, with nobody yet
    t.ctx.db.prepare(`DELETE FROM settings WHERE key = 'teams_settings'`).run();
    expect(teamsEnabled(t.ctx)).toBe(false); // missing reads as off
    expect(prepareData(t.ctx).teams).toBe(true); // a 1.5.0-rc install already working as a team
    expect(teamsEnabled(t.ctx)).toBe(true);
    // Never again: a saved value (an admin's choice) stays.
    teams(false);
    expect(prepareData(t.ctx).teams).toBeNull();
    expect(backfillTeamsSetting(t.ctx)).toBeNull();
    expect(teamsEnabled(t.ctx)).toBe(false);

    // One active person (a 1.4 upgrade's owner): off. Deactivated people don't count.
    const solo = makeCtx();
    try {
      solo.ctx.db.prepare(`DELETE FROM settings WHERE key = 'teams_settings'`).run();
      createUser(solo.ctx, { username: 'admin', displayName: 'Admin', role: 'admin' }, 'hash');
      const gone = createUser(solo.ctx, { username: 'kim', displayName: 'Kim', role: 'member' }, 'hash').id;
      solo.ctx.db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run('2026-10-01T00:00:00.000Z', gone);
      expect(prepareData(solo.ctx).teams).toBe(false);
      expect(teamsRow(solo.ctx.db)).toBe('{"enabled":false}');
      // A second person later doesn't change it: that's the admin's call.
      createUser(solo.ctx, { username: 'sam', displayName: 'Sam', role: 'member' }, 'hash');
      expect(prepareData(solo.ctx).teams).toBeNull();
      expect(teamsEnabled(solo.ctx)).toBe(false);
    } finally {
      solo.close();
    }
  });

  it('a restored backup from before the setting gets the same first value; one with it keeps it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tt-teams-'));
    try {
      const restored = (name: string, data: ReturnType<typeof exportData>) => {
        const file = path.join(dir, `${name}.db`);
        buildRestoreDb(data, file, t.ctx.tz, t.clock);
        const db = openDatabase(file);
        try {
          return teamsRow(db);
        } finally {
          db.close();
        }
      };
      t.ctx.db.prepare(`DELETE FROM settings WHERE key = 'teams_settings'`).run();
      const rc = exportData(t.ctx, '1.5.0-rc.1'); // no teams_settings yet, three active people
      expect((rc.tables.settings as { key: string }[]).some((r) => r.key === 'teams_settings')).toBe(false);
      expect(restored('rc', rc)).toBe('{"enabled":true}');
      teams(false);
      expect(restored('final', exportData(t.ctx, '1.5.0'))).toBe('{"enabled":false}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('goes into backups like the other settings', () => {
    teams(true);
    const settings = exportData(t.ctx, 'test').tables.settings as { key: string; value: string }[];
    expect(settings.find((r) => r.key === 'teams_settings')).toEqual({ key: 'teams_settings', value: '{"enabled":true}' });
  });
});

describe('with Teams off', () => {
  it('notifyPeople writes nothing but `submitted`', () => {
    const card = createCard(as('owner'), { title: 'Replace UPS battery' });
    updateCard(as('owner'), card.id, { assigneeId: people.jordan! }); // assigned
    addWorklog(as('owner'), card.id, { bodyMd: 'Swapped it, @alex @jordan can you check?' }); // mentioned, watching
    moveCard(as('alex'), card.id, { toColumnId: columnId(t.ctx, 'In Progress'), afterCardId: null }); // watching
    setPrefs('alex', { new_unassigned: everywhere });
    fromMonitor('NAS offline'); // new_unassigned
    const activityId = t.ctx.db.prepare('SELECT max(id) FROM activity').pluck().get() as number;
    for (const type of ['assigned', 'mentioned', 'watching', 'new_unassigned'] as const) {
      expect(notifyPeople(t.ctx, { cardId: card.id, activityId, type, userIds: Object.values(people), data: {} }), type).toEqual([]);
    }
    expect(t.ctx.db.prepare('SELECT count(*) FROM notifications').pluck().get()).toBe(0);
    expect(events.filter((e) => e.type === 'people_notified')).toEqual([]);
  });

  it('a submit-page ticket tells every active admin, in the app only, whatever their prefs', () => {
    person('casey', 'admin', { submitted: nowhere }); // turned off while Teams was on: solo mode tells them anyway
    person('drew', 'admin');
    person('riley', 'member', { submitted: everywhere, new_unassigned: everywhere });
    t.ctx.db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run('2026-10-01T00:00:00.000Z', people.drew!);
    const id = submit('Sam');
    for (const admin of ['owner', 'alex', 'casey']) {
      expect(rows(admin), admin).toEqual(['submitted']);
      expect(bell(admin), admin).toEqual(['submitted: New ticket from submit page (Sam)']);
    }
    expect(rows('drew')).toEqual([]); // deactivated
    expect(rows('jordan')).toEqual([]); // members get nothing
    expect(rows('riley')).toEqual([]);
    expect(listNotifications(t.ctx, people.owner!, { limit: 5 }).items[0]).toMatchObject({ cardId: id, actorName: 'submit page (Sam)', readAt: null });
    // Not for personal channels.
    expect(events.filter((e) => e.type === 'people_notified')).toEqual([]);
  });

  it('only the submit page counts: API tokens and cards made in the app tell nobody', () => {
    fromMonitor('NAS offline');
    createCard(as('jordan'), { title: 'Made in the app' });
    expect(t.ctx.db.prepare('SELECT count(*) FROM notifications').pluck().get()).toBe(0);
  });

  it('the bell lists only `submitted`; marking read leaves the others for when Teams is back', () => {
    teams(true);
    const card = createCard(as('alex'), { title: 'Fans loud' });
    updateCard(as('alex'), card.id, { assigneeId: people.owner! });
    expect(bell('owner')).toEqual(['assigned: Alex assigned this to you']);

    teams(false);
    expect(bell('owner')).toEqual([]);
    expect(unread('owner')).toBe(0);
    expect(listNotifications(t.ctx, people.owner!, { limit: 1 }).teams).toBe(false);
    const submitted = submit();
    expect(bell('owner')).toEqual(['submitted: New ticket from submit page (Sam)']);
    expect(markNotificationsRead(t.ctx, people.owner!, { all: true })).toBe(0);
    expect(markNotificationsRead(t.ctx, people.owner!, { cardId: card.id })).toBe(0);
    expect(listNotifications(t.ctx, people.owner!, { limit: 5 }).items[0]).toMatchObject({ cardId: submitted });
    expect(listNotifications(t.ctx, people.owner!, { limit: 5 }).items[0]!.readAt).not.toBeNull();

    teams(true);
    expect(bell('owner')).toEqual(['submitted: New ticket from submit page (Sam)', 'assigned: Alex assigned this to you']);
    expect(unread('owner')).toBe(1); // the assignment is still unread
  });

  it('@name is plain text: a note makes only its writer watch, editing it in mentions nobody', () => {
    const card = createCard(t.ctx, { title: 'Garage door sensor' });
    const note = addWorklog(as('owner'), card.id, { bodyMd: 'Swapped the battery, @alex can you check?' });
    expect(watchers(card.id)).toEqual(['owner']);
    updateWorklog(as('owner'), note.id, { bodyMd: 'Swapped the battery, @alex @jordan can you check?' });
    expect(watchers(card.id)).toEqual(['owner']);
    expect(rows('alex')).toEqual([]);
    // With Teams on, a mention makes them watch.
    teams(true);
    addWorklog(as('owner'), card.id, { bodyMd: 'Still beeping, @jordan' });
    expect(watchers(card.id)).toEqual(['jordan', 'owner']);
  });

  it('assignments and watchers are kept, and work through the services, across switching it off and on', () => {
    teams(true);
    const card = createCard(as('alex'), { title: 'Cert renewal', assigneeId: people.jordan! });
    watchCard(t.ctx, card.id, people.owner!);
    teams(false);
    expect(getCard(as('jordan'), card.id)).toMatchObject({ assigneeId: people.jordan!, watching: true });
    expect(getCard(as('owner'), card.id).watching).toBe(true);
    // Still works while off, quietly.
    const other = createCard(as('owner'), { title: 'Other' });
    updateCard(as('owner'), other.id, { assigneeId: people.alex! });
    watchCard(t.ctx, other.id, people.jordan!);
    expect(getCard(as('jordan'), other.id)).toMatchObject({ assigneeId: people.alex!, watching: true });
    expect(rows('alex')).toEqual([]);
    teams(true);
    expect(getCard(as('jordan'), card.id)).toMatchObject({ assigneeId: people.jordan!, watching: true });
    expect(getCard(as('jordan'), other.id).watching).toBe(true);
    expect(getCard(as('alex'), other.id).assigneeId).toBe(people.alex!);
  });
});

describe('with Teams on', () => {
  beforeEach(() => teams(true));

  it('`submitted` follows each person’s prefs: in the app for admins by default, off for members', () => {
    person('casey', 'admin', { submitted: nowhere });
    person('riley', 'member', { submitted: inApp });
    submit();
    expect(rows('owner')).toEqual(['submitted']);
    expect(rows('alex')).toEqual(['submitted']);
    expect(rows('casey')).toEqual([]);
    expect(rows('jordan')).toEqual([]);
    expect(rows('riley')).toEqual(['submitted']);
  });

  it('a submit-page ticket rings once per person: `submitted` wins over `new_unassigned`, on the channels of both', () => {
    setPrefs('owner', { new_unassigned: inApp }); // both apply: only submitted
    // Submitted only on Discord, new unassigned tickets in the app: one row, in the bell (and on Discord).
    setPrefs('alex', { submitted: { inApp: false, discord: true, ntfy: false }, new_unassigned: inApp });
    setPrefs('jordan', { new_unassigned: inApp }); // a member: submitted is off, so new_unassigned
    submit();
    expect(rows('owner')).toEqual(['submitted']);
    expect(rows('alex')).toEqual(['submitted']);
    expect(bell('alex')).toEqual(['submitted: New ticket from submit page (Sam)']);
    expect(rows('jordan')).toEqual(['new_unassigned']);
    // A monitor's ticket isn't `submitted` (a token's owner is told too).
    fromMonitor('NAS offline');
    expect(rows('owner')).toEqual(['submitted', 'new_unassigned']);
    expect(rows('jordan')).toEqual(['new_unassigned', 'new_unassigned']);
  });

  it('stored prefs without `submitted` take the default, and saving without it keeps what’s saved', () => {
    setPrefs('alex', { assigned: nowhere });
    setPrefs('jordan', { assigned: nowhere });
    expect(personalNotifySettings(t.ctx, people.alex!).prefs.submitted).toEqual(inApp);
    expect(personalNotifySettings(t.ctx, people.jordan!).prefs.submitted).toEqual(nowhere);
    const { submitted: _left, ...older } = { ...DEFAULT_NOTIFY_PREFS, assigned: inApp };
    setPrefs('alex', { submitted: { inApp: false, discord: true, ntfy: false } });
    const saved = updatePersonalNotify(t.ctx, people.alex!, { discordUserId: null, ntfyTopic: null, prefs: older });
    expect(saved.prefs).toEqual({ ...DEFAULT_NOTIFY_PREFS, submitted: { inApp: false, discord: true, ntfy: false } });
  });
});

describe('personal channels', () => {
  const WEBHOOK = 'https://discord.com/api/webhooks/123/abc';
  /** Where each message went, and its text (a personal Discord message's content, an ntfy message). */
  let sent: { url: string; text: string }[];
  let notifier: Notifier;

  beforeEach(() => {
    sent = [];
    notifier = new Notifier(
      async (url, init) => {
        const body = JSON.parse(init.body) as { content?: string; message?: string };
        sent.push({ url, text: body.content ?? body.message ?? '' });
        return { ok: true, status: 204, headers: { get: () => null }, text: async () => '' };
      },
      [0, 0],
      { coalesceMs: 60_000 },
    );
    // The install's own channels announce outside tickets; personal messages ride on them.
    updateDiscordSettings(t.ctx, { webhookUrl: WEBHOOK, events: { external: true, critical: false, digest: false, blocked: false } });
    updateChannelSettings(t.ctx, 'ntfy', { url: 'https://push.example/install-topic', secret: null, events: { external: false, critical: false, digest: false, blocked: false } });
    const prefs = { assigned: everywhere, mentioned: everywhere, watching: everywhere, new_unassigned: everywhere, submitted: everywhere };
    for (const name of ['owner', 'jordan']) {
      t.ctx.db
        .prepare('UPDATE users SET discord_user_id = ?, ntfy_topic = ?, notify_prefs = ? WHERE id = ?')
        .run('123456789012345678', `belltower-${name}-x7Kq2`, JSON.stringify(prefs), people[name]!);
    }
  });

  async function deliver() {
    for (const e of events.splice(0)) await notifier.handle(t.ctx, e);
    await notifier.flushPersonal(t.ctx);
  }

  it('nothing personal goes out while Teams is off; the install’s channel still announces the ticket', async () => {
    const card = createCard(as('alex'), { title: 'Fans loud' });
    updateCard(as('alex'), card.id, { assigneeId: people.jordan! });
    addWorklog(as('alex'), card.id, { bodyMd: '@owner have a look' });
    submit('Sam');
    await deliver();
    // Only the install's own announcement (an embed, mentioning nobody).
    expect(sent).toEqual([{ url: WEBHOOK, text: '' }]);
    expect(rows('owner')).toEqual(['submitted']);
  });

  it('a Discord ping for new unassigned tickets still comes for a submit-page ticket: one bell row, one message', async () => {
    teams(true);
    const ALEX_DISCORD = '223456789012345678';
    // An rc.1 admin: Discord for "New tickets nobody has", "submit page" left at its default (in the app).
    t.ctx.db
      .prepare('UPDATE users SET discord_user_id = ?, notify_prefs = ? WHERE id = ?')
      .run(ALEX_DISCORD, JSON.stringify({ new_unassigned: { inApp: false, discord: true, ntfy: false } }), people.alex!);
    submit('Sam');
    await deliver();
    expect(rows('alex')).toEqual(['submitted']);
    expect(bell('alex')).toEqual(['submitted: New ticket from submit page (Sam)']);
    const toAlex = sent.filter((m) => m.text.includes(`<@${ALEX_DISCORD}>`));
    expect(toAlex).toHaveLength(1);
    expect(toAlex[0]!.url).toBe(WEBHOOK);
    expect(toAlex[0]!.text).toContain('New ticket from submit page (Sam)');
  });

  it('with Teams on they do; turned off before they go out, they don’t', async () => {
    teams(true);
    submit('Sam');
    await deliver();
    // The install's announcement, then a Discord mention and an ntfy message each for the owner
    // (an admin) and Jordan (a member who opted in).
    expect(sent).toHaveLength(5);
    expect(sent.filter((m) => m.text.includes('New ticket from submit page (Sam)'))).toHaveLength(4);
    expect(sent.filter((m) => m.url.startsWith('https://push.example')).map((m) => m.text)).toEqual([
      'New ticket from submit page (Sam)',
      'New ticket from submit page (Sam)',
    ]);

    sent = [];
    const card = createCard(as('alex'), { title: 'Cert renewal' });
    updateCard(as('alex'), card.id, { assigneeId: people.jordan! });
    for (const e of events.splice(0)) await notifier.handle(t.ctx, e);
    expect(notifier.waitingPeople).toBe(1);
    teams(false);
    await notifier.flushPersonal(t.ctx);
    expect(sent).toEqual([]);
  });
});

describe('over HTTP', () => {
  let app: TestApp | undefined;
  afterEach(async () => {
    await app?.shutdown();
    app = undefined;
  });

  it('admins switch it; members read it, and whether the submit page is on, from /api/config', async () => {
    app = await makeApp();
    const adminCookie = await setupAndLogin(app);
    const admin = client(app.app, adminCookie);
    const sam = await addPerson(app, adminCookie, 'sam');
    const member = client(app.app, sam.cookie);

    expect((await member('GET', '/api/config')).json()).toMatchObject({ teams: false, submitPageEnabled: false });
    expect((await member('GET', '/api/settings')).json().teams).toEqual({ enabled: false });
    expect((await member('PUT', '/api/settings/teams', { enabled: true })).statusCode).toBe(403);
    expect((await admin('PUT', '/api/settings/teams', { enabled: 'yes' })).statusCode).toBe(400);
    expect((await admin('PUT', '/api/settings/teams', {})).statusCode).toBe(400);

    const res = await admin('PUT', '/api/settings/teams', { enabled: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().teams).toEqual({ enabled: true });
    updateSubmitSettings(app.ctx, { enabled: true, columnId: null, pageTitle: 'P', intro: '' });
    expect((await member('GET', '/api/config')).json()).toMatchObject({ teams: true, submitPageEnabled: true });
    expect((await admin('PUT', '/api/settings/teams', { enabled: false })).json().teams).toEqual({ enabled: false });
    expect((await member('GET', '/api/config')).json()).toMatchObject({ teams: false, submitPageEnabled: true });
  });

  it('assigning and watching through the API keep working while it’s off', async () => {
    app = await makeApp();
    const adminCookie = await setupAndLogin(app);
    const admin = client(app.app, adminCookie);
    const sam = await addPerson(app, adminCookie, 'sam');
    const card = (await admin('POST', '/api/cards', { title: 'Garage door sensor', assigneeId: sam.id })).json();
    expect(card.assigneeId).toBe(sam.id);
    const patched = await admin('PATCH', `/api/cards/${card.id}`, { assigneeId: null, expectedVersion: card.version });
    expect(patched.json()).toMatchObject({ assigneeId: null, version: card.version + 1 });
    expect((await client(app.app, sam.cookie)('PUT', `/api/cards/${card.id}/watch`)).json()).toEqual({ watching: true });
    expect((await client(app.app, sam.cookie)('GET', `/api/cards/${card.id}`)).json().watching).toBe(true);
    expect((await client(app.app, sam.cookie)('GET', '/api/notifications')).json()).toMatchObject({ items: [], unread: 0 });
  });
});

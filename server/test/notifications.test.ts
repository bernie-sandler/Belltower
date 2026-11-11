// 1.5 personal notifications: who is told about what, watching, @mentions, the bell's API, personal
// Discord and ntfy messages (combined per person), and pruning.

import { DEFAULT_NOTIFY_PREFS, findMentions, type Actor, type NotifyPrefs } from '@tt/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listActivity } from '../src/services/activity';
import { importCards } from '../src/services/cardImport';
import { archiveCard, completeCard, createCard, getCard, moveCard, moveCards, updateCard } from '../src/services/cards';
import { withActor, type AppEvent, type Ctx } from '../src/services/context';
import { intakeCard } from '../src/services/intake';
import { listNotifications, markNotificationsRead, notifyPeople, pruneNotifications, watchCard } from '../src/services/notifications';
import { Notifier, WEBHOOK_EVENTS } from '../src/services/notify';
import { updateChannelSettings, updateDiscordSettings, updateGeneralSettings } from '../src/services/settings';
import { createToken } from '../src/services/tokens';
import { createUser, updateUser } from '../src/services/users';
import { addWorklog, updateWorklog } from '../src/services/worklog';
import { addPerson, client, columnId, enableTeams, loginAs, makeApp, makeCtx, setupAndLogin, type TestApp } from './helpers';

let t: ReturnType<typeof makeCtx>;
let events: AppEvent[];
const people: Record<string, number> = {};

const as = (name: string): Ctx => withActor(t.ctx, { kind: 'user', userId: people[name]! });
const actorAs = (actor: Actor): Ctx => withActor(t.ctx, actor);

function person(username: string, displayName: string, prefs?: Partial<NotifyPrefs>): number {
  const id = createUser(t.ctx, { username, displayName, role: 'member' }, 'not-a-real-hash').id;
  if (prefs) t.ctx.db.prepare('UPDATE users SET notify_prefs = ? WHERE id = ?').run(JSON.stringify({ ...DEFAULT_NOTIFY_PREFS, ...prefs }), id);
  people[username] = id;
  return id;
}

/** What each person's bell says: "type: text" lines, newest first. */
function bell(name: string): string[] {
  return listNotifications(t.ctx, people[name]!, { limit: 100 }).items.map((n) => `${n.type}: ${n.text}`);
}

const unread = (name: string) => listNotifications(t.ctx, people[name]!, { limit: 1 }).unread;
const watchers = (cardId: number) =>
  (t.ctx.db.prepare('SELECT u.username FROM card_watchers w JOIN users u ON u.id = w.user_id WHERE card_id = ? ORDER BY u.username').pluck().all(cardId) as string[]);

beforeEach(() => {
  t = makeCtx();
  // These are the team features (Settings → General → Teams); teams.test.ts covers them turned off.
  enableTeams(t.ctx);
  events = [];
  t.ctx.emit = (e) => events.push(e);
  for (const k of Object.keys(people)) delete people[k];
  person('alice', 'Alice');
  person('bob', 'Bob');
  person('carol', 'Carol');
});
afterEach(() => t.close());

describe('who is told about what', () => {
  it('assigned: the new assignee, who watches the card from then on', () => {
    const card = createCard(as('alice'), { title: 'Replace UPS battery' });
    updateCard(as('alice'), card.id, { assigneeId: people.bob! });
    expect(bell('bob')).toEqual(['assigned: Alice assigned this to you']);
    expect(bell('alice')).toEqual([]);
    expect(watchers(card.id)).toEqual(['alice', 'bob']);
  });

  it('assigned at creation, and taking a card yourself tells only the watchers', () => {
    const card = createCard(as('alice'), { title: 'Cert renewal', assigneeId: people.bob! });
    expect(bell('bob')).toEqual(['assigned: Alice assigned this to you']);
    watchCard(t.ctx, card.id, people.carol!);
    updateCard(as('carol'), card.id, { assigneeId: people.carol! });
    // Carol took it: she isn't told about her own action; Alice and Bob watch it.
    expect(bell('carol')).toEqual([]);
    expect(bell('alice')).toEqual(['watching: Carol took this']);
    expect(bell('bob')[0]).toBe('watching: Carol took this');
    updateCard(as('alice'), card.id, { assigneeId: null });
    expect(bell('carol')[0]).toBe('watching: Alice unassigned Carol');
  });

  it('mentioned: @username in a new note, once, and they watch the card; the writer watches it too', () => {
    const card = createCard(t.ctx, { title: 'Disk 3 SMART errors' });
    addWorklog(as('alice'), card.id, { bodyMd: 'Swapped the cable. @Bob can you check the logs? cc @bob' });
    expect(bell('bob')).toEqual(['mentioned: Alice mentioned you: “Swapped the cable. @Bob can you check the logs? cc @bob”']);
    expect(watchers(card.id)).toEqual(['alice', 'bob']);
  });

  it('watching: a new note, a move, done, reopened and an assignee change; mentions and assignments win over watching', () => {
    const card = createCard(t.ctx, { title: 'Plex buffering' });
    watchCard(t.ctx, card.id, people.carol!);
    addWorklog(as('alice'), card.id, { bodyMd: 'Direct play works on the TV.' });
    moveCard(as('alice'), card.id, { toColumnId: columnId(t.ctx, 'In Progress'), afterCardId: null });
    completeCard(as('alice'), card.id, { includeChildren: false });
    moveCard(as('alice'), card.id, { toColumnId: columnId(t.ctx, 'Backlog'), afterCardId: null });
    updateCard(as('alice'), card.id, { assigneeId: people.bob! });
    expect(bell('carol')).toEqual([
      'watching: Alice assigned this to Bob',
      'watching: Alice reopened this (now in Backlog)',
      'watching: Alice marked this done',
      'watching: Alice moved this to In Progress',
      'watching: Alice added a note: “Direct play works on the TV.”',
    ]);
    // Bob was assigned it (not "watching: assigned this to Bob"); a note mentioning Carol is a mention.
    expect(bell('bob')).toEqual(['assigned: Alice assigned this to you']);
    addWorklog(as('alice'), card.id, { bodyMd: 'Over to you, @carol' });
    expect(bell('carol')[0]).toBe('mentioned: Alice mentioned you: “Over to you, @carol”');
    expect(bell('bob')[0]).toBe('watching: Alice added a note: “Over to you, @carol”');
    // Other edits (title, priority) and archiving don't notify.
    const before = bell('carol').length;
    updateCard(as('alice'), card.id, { title: 'Plex buffering on the TV', priority: 'high' });
    completeCard(as('alice'), card.id, { includeChildren: false });
    archiveCard(as('alice'), card.id);
    expect(bell('carol')).toHaveLength(before + 1); // only "marked this done"
  });

  it('someone who turned mentions (or assignments) off still hears about it as a watcher', () => {
    person('erin', 'Erin', { mentioned: { inApp: false, discord: false, ntfy: false }, assigned: { inApp: false, discord: false, ntfy: false } });
    const card = createCard(t.ctx, { title: 'UPS beeping' });
    watchCard(t.ctx, card.id, people.erin!);
    addWorklog(as('alice'), card.id, { bodyMd: 'Battery ordered, @erin' });
    updateCard(as('alice'), card.id, { assigneeId: people.erin! });
    expect(bell('erin')).toEqual(['watching: Alice assigned this to Erin', 'watching: Alice added a note: “Battery ordered, @erin”']);
  });

  it('a card parked in the blocked column tells its watchers why', () => {
    const blocker = createCard(t.ctx, { title: 'Order the new drive' });
    const card = createCard(t.ctx, { title: 'Replace disk 3', columnId: columnId(t.ctx, 'In Progress') });
    t.ctx.db.prepare(`INSERT INTO settings (key, value) VALUES ('blocked_column_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
      String(columnId(t.ctx, 'Blocked/Waiting')),
    );
    watchCard(t.ctx, card.id, people.carol!);
    t.ctx.db.prepare(`INSERT INTO card_links (from_card_id, to_card_id, type, created_at) VALUES (?, ?, 'blocks', ?)`).run(blocker.id, card.id, '2026-10-10T15:00:00.000Z');
    // Reopening the blocker parks the cards it blocks: done first, then back.
    completeCard(t.ctx, blocker.id, { includeChildren: false });
    moveCard(as('alice'), card.id, { toColumnId: columnId(t.ctx, 'Backlog'), afterCardId: null });
    moveCard(as('alice'), blocker.id, { toColumnId: columnId(t.ctx, 'Triage'), afterCardId: null });
    expect(bell('carol')[0]).toBe('watching: Moved to Blocked/Waiting: it’s blocked');
  });

  it('new_unassigned: only people who opted in, only outside tickets with nobody assigned', () => {
    person('dave', 'Dave', { new_unassigned: { inApp: true, discord: false, ntfy: false } });
    createCard(actorAs({ kind: 'public' }), { title: 'Wi-Fi is down' }, { source: 'api', via: 'submit page (Sam)', external: true });
    createCard(actorAs({ kind: 'public' }), { title: 'Already handled', assigneeId: people.bob! }, { source: 'api', external: true });
    createCard(as('alice'), { title: 'Mine, made in the app' });
    expect(bell('dave')).toEqual(['new_unassigned: New ticket from submit page (Sam), not assigned yet']);
    expect(listNotifications(t.ctx, people.dave!, { limit: 5 }).items[0]!.actorName).toBe('submit page (Sam)');
    expect(bell('alice')).toEqual([]);
    expect(bell('carol')).toEqual([]);
  });

  it('only cards made in the app are watched by their maker (not imports, templates or outside tickets)', () => {
    const own = createCard(as('alice'), { title: 'Mine' });
    const imported = createCard(as('alice'), { title: 'Imported' }, { source: 'api', via: 'card import' });
    const recurring = createCard(t.ctx, { title: 'Monthly parity check' }, { source: 'recurring' });
    expect(getCard(as('alice'), own.id).watching).toBe(true);
    expect(getCard(as('alice'), imported.id).watching).toBe(false);
    expect(getCard(as('alice'), recurring.id).watching).toBe(false);
    expect(getCard(as('bob'), own.id).watching).toBe(false);
  });
});

describe('imports are history', () => {
  it('imported notes notify nobody, old @mentions included, and don’t make the importer watch', () => {
    const text = JSON.stringify({
      format: 'belltower/cards@1',
      cards: [{ title: 'Old ticket', worklog: [{ text: 'Back then @bob swapped the PSU, cc @carol', at: '2026-10-01 10:00' }] }],
    });
    const [id] = importCards(as('alice'), text, false).created;
    expect(bell('bob')).toEqual([]);
    expect(bell('carol')).toEqual([]);
    expect(watchers(id!)).toEqual([]);
    expect(events.filter((e) => e.type === 'people_notified')).toEqual([]);
    expect(listActivity(t.ctx, id!).find((e) => e.kind === 'worklog')!.bodyMd).toContain('@bob');
  });

  it('a new ticket through the automation API: its notes are quiet, but “Seen again” tells the watchers', () => {
    person('dave', 'Dave', { new_unassigned: { inApp: true, discord: false, ntfy: false } });
    const { info } = createToken(as('alice'), { name: 'Kuma', canComplete: false });
    const token = { id: info.id, name: 'Kuma', canComplete: false, scope: 'full' as const, userId: people.alice! };
    const kuma = actorAs({ kind: 'token', tokenId: info.id, userId: people.alice! });
    const first = intakeCard(kuma, token, { title: 'NAS offline', dedupeKey: 'nas', worklog: [{ text: 'Paging @carol', at: '2026-10-09 20:15' }] });
    const id = first.card!.id;
    expect(bell('carol')).toEqual([]);
    expect(bell('dave')).toEqual(['new_unassigned: New ticket from API token “Kuma”, not assigned yet']);
    watchCard(t.ctx, id, people.carol!);
    expect(intakeCard(kuma, token, { title: 'NAS offline', dedupeKey: 'nas' }).status).toBe('updated');
    expect(bell('carol')).toEqual(['watching: API token “Kuma” added a note: “Seen again (reported by API token “Kuma”).”']);
  });
});

describe('who is never told', () => {
  it('the person acting, but a token tells its owner', () => {
    const card = createCard(as('alice'), { title: 'Backups failing' });
    moveCard(as('alice'), card.id, { toColumnId: columnId(t.ctx, 'In Progress'), afterCardId: null });
    expect(bell('alice')).toEqual([]);
    const { info } = createToken(as('alice'), { name: 'Kuma', canComplete: true });
    addWorklog(actorAs({ kind: 'token', tokenId: info.id, userId: people.alice! }), card.id, { bodyMd: 'Seen again (reported by Kuma).' });
    expect(bell('alice')).toEqual(['watching: API token “Kuma” added a note: “Seen again (reported by Kuma).”']);
    // A token's note doesn't make its owner watch anything new.
    const other = createCard(t.ctx, { title: 'Router reboot' });
    addWorklog(actorAs({ kind: 'token', tokenId: info.id, userId: people.alice! }), other.id, { bodyMd: 'Down' });
    expect(watchers(other.id)).toEqual([]);
  });

  it('deactivated people: no notifications, and @mentions don’t match them', () => {
    const card = createCard(as('alice'), { title: 'NAS fan noise' });
    watchCard(t.ctx, card.id, people.bob!);
    updateUser(t.ctx, people.bob!, { disabled: true }, { ownerPasswordFromEnv: false });
    addWorklog(as('alice'), card.id, { bodyMd: 'Hey @bob and @carol' });
    expect(t.ctx.db.prepare('SELECT count(*) FROM notifications WHERE user_id = ?').pluck().get(people.bob!)).toBe(0);
    expect(bell('carol')).toHaveLength(1);
    expect(watchers(card.id)).toEqual(['alice', 'bob', 'carol']); // bob's watch stays, for when he's back
  });

  it('people who turned an event off everywhere; turning off only the bell keeps it out of the bell', () => {
    person('erin', 'Erin', { watching: { inApp: false, discord: false, ntfy: false } });
    person('finn', 'Finn', { watching: { inApp: false, discord: true, ntfy: false } });
    const card = createCard(t.ctx, { title: 'Pi-hole update' });
    for (const n of ['erin', 'finn']) watchCard(t.ctx, card.id, people[n]!);
    addWorklog(as('alice'), card.id, { bodyMd: 'Updated' });
    const rows = (name: string) => t.ctx.db.prepare('SELECT read_at, data FROM notifications WHERE user_id = ?').all(people[name]!) as { read_at: string | null; data: string }[];
    expect(rows('erin')).toEqual([]);
    expect(rows('finn')).toHaveLength(1); // for Discord, read and hidden
    expect(rows('finn')[0]!.read_at).not.toBeNull();
    expect(bell('finn')).toEqual([]);
    expect(unread('finn')).toBe(0);
  });
});

describe('@mentions', () => {
  const known = new Set(['sam', 'sam.smith', 'al', 'bob_2', 'kim']);
  it.each([
    ['plain and case-insensitive', 'thanks @Sam and @KIM', ['sam', 'kim']],
    ['once each, in order', '@kim @sam @kim', ['kim', 'sam']],
    ['punctuation after the name', 'ask @sam, then @kim. Or (@al)!', ['sam', 'kim', 'al']],
    ['a dotted name, and a trailing dot dropped', 'cc @sam.smith. and @sam.', ['sam.smith', 'sam']],
    ['email addresses are not mentions', 'mail sam@example.com or kim+x@kim.dev', []],
    ['URLs and handles elsewhere are not mentions', 'see https://mastodon.social/@sam and @kim@other.host', []],
    ['an escaped @ is not a mention', 'literally \\@sam here', []],
    ['inline code is not a mention', 'run `ssh @sam` then ping @kim', ['kim']],
    ['double-backtick code is not a mention', 'run ``echo `x` @sam`` @al', ['al']],
    ['fenced code is not a mention', 'before @kim\n```\nchown @sam file\n```\nafter @al', ['kim', 'al']],
    ['an unclosed fence runs to the end', 'see\n~~~\n@sam\n@kim', []],
    ['an indented code block is not a mention', 'before @kim\n\n    chown @sam file\n\tssh @al\n\nafter @al', ['kim', 'al']],
    ['an indented line right after text continues the paragraph', 'text\n    cc @sam', ['sam']],
    ['an indented line after a list item continues the item', '- item\n\n    more for @sam', ['sam']],
    ['unknown names are ignored', '@nobody @bob_2', ['bob_2']],
    ['a lone @ or one letter is nothing', '@ and @a', []],
  ])('%s', (_name, text, expected) => {
    expect(findMentions(text, known)).toEqual(expected);
  });

  it('an edit notifies only names it didn’t mention before; the unique index stops repeats', () => {
    const card = createCard(t.ctx, { title: 'DNS' });
    const note = addWorklog(as('alice'), card.id, { bodyMd: 'Asking @bob' });
    updateWorklog(as('alice'), note.id, { bodyMd: 'Asking @bob and @carol' });
    updateWorklog(as('alice'), note.id, { bodyMd: 'Asking @carol' });
    updateWorklog(as('alice'), note.id, { bodyMd: 'Asking @carol and @bob again' });
    expect(bell('bob')).toEqual(['mentioned: Alice mentioned you: “Asking @bob”']);
    expect(bell('carol')).toEqual(['mentioned: Alice mentioned you: “Asking @bob and @carol”']);
  });

  it('a retracted note notifies nobody, and its mentions leave the bell until it’s restored', () => {
    const card = createCard(t.ctx, { title: 'VPN' });
    const note = addWorklog(as('alice'), card.id, { bodyMd: 'Ping @bob' });
    updateWorklog(as('alice'), note.id, { retracted: true });
    expect(bell('bob')).toEqual([]);
    expect(unread('bob')).toBe(0);
    updateWorklog(as('alice'), note.id, { bodyMd: 'Ping @bob and @carol' });
    expect(bell('carol')).toEqual([]);
    updateWorklog(as('alice'), note.id, { retracted: false });
    expect(bell('bob')).toHaveLength(1);
    expect(bell('carol')).toEqual([]); // the edit came while it was retracted
  });
});

describe('the bell', () => {
  it('lists newest first with the card and who did it, counts unread, marks some or all read', () => {
    const a = createCard(t.ctx, { title: 'First' });
    const b = createCard(t.ctx, { title: 'Second' });
    updateCard(as('alice'), a.id, { assigneeId: people.bob! });
    updateCard(as('alice'), b.id, { assigneeId: people.bob! });
    const list = listNotifications(t.ctx, people.bob!, { limit: 30 });
    expect(list.unread).toBe(2);
    expect(list.items.map((n) => [n.cardTitle, n.ticketNo, n.actorName, n.readAt])).toEqual([
      ['Second', b.ticketNo, 'Alice', null],
      ['First', a.ticketNo, 'Alice', null],
    ]);
    expect(list.latestId).toBe(list.items[0]!.id);
    expect(listNotifications(t.ctx, people.bob!, { limit: 30, after: list.items[1]!.id }).items).toHaveLength(1);
    expect(markNotificationsRead(t.ctx, people.bob!, { ids: [list.items[1]!.id] })).toBe(1);
    // Opening a card marks what's about it read (someone else's about the same card stay unread).
    updateCard(as('alice'), b.id, { assigneeId: people.carol! });
    expect(markNotificationsRead(t.ctx, people.carol!, { cardId: a.id })).toBe(1);
    expect(markNotificationsRead(t.ctx, people.carol!, { cardId: b.id })).toBe(0);
    expect(markNotificationsRead(t.ctx, people.bob!, { cardId: b.id })).toBe(0);
    expect(unread('bob')).toBe(0);
    t.ctx.db.prepare('UPDATE notifications SET read_at = NULL WHERE id = ?').run(list.items[0]!.id);
    expect(markNotificationsRead(t.ctx, people.carol!, { all: true })).toBe(0); // someone else's stay unread
    expect(unread('bob')).toBe(1);
    expect(markNotificationsRead(t.ctx, people.bob!, { all: true })).toBe(0);
  });

  it('writes each notification once per person and change', () => {
    const card = createCard(t.ctx, { title: 'Once' });
    const activityId = t.ctx.db.prepare('SELECT max(id) FROM activity').pluck().get() as number;
    const input = { cardId: card.id, activityId, type: 'watching' as const, userIds: [people.bob!, people.bob!], data: { what: 'note' as const, excerpt: 'x' } };
    expect(notifyPeople(t.ctx, input)).toHaveLength(1);
    expect(notifyPeople(t.ctx, input)).toEqual([]);
    expect(bell('bob')).toHaveLength(1);
  });

  it('prunes read ones after 30 days and any after 90', () => {
    const card = createCard(t.ctx, { title: 'Old news' });
    const insert = t.ctx.db.prepare(
      `INSERT INTO notifications (user_id, card_id, activity_id, type, data, created_at, read_at) VALUES (?, ?, NULL, 'assigned', '{}', ?, ?)`,
    );
    const daysAgo = (d: number) => new Date(Date.parse('2026-10-10T15:00:00.000Z') - d * 86_400_000).toISOString();
    insert.run(people.bob!, card.id, daysAgo(31), daysAgo(30)); // read, old: goes
    insert.run(people.bob!, card.id, daysAgo(29), daysAgo(1)); // read, recent: stays
    insert.run(people.bob!, card.id, daysAgo(60), null); // unread, 60 days: stays
    insert.run(people.bob!, card.id, daysAgo(91), null); // unread, 91 days: goes
    expect(pruneNotifications(t.ctx)).toBe(2);
    expect(t.ctx.db.prepare('SELECT count(*) FROM notifications').pluck().get()).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// Personal Discord and ntfy
// ---------------------------------------------------------------------------------------------

describe('personal channels', () => {
  interface Sent {
    url: string;
    headers: Record<string, string>;
    json: Record<string, unknown>;
  }
  let sent: Sent[];
  let notifier: Notifier;
  const WEBHOOK = 'https://discord.com/api/webhooks/123/abc';
  const BOB_DISCORD = '123456789012345678';
  const everywhere = { inApp: true, discord: true, ntfy: true };

  beforeEach(() => {
    sent = [];
    notifier = new Notifier(
      async (url, init) => {
        sent.push({ url, headers: init.headers, json: JSON.parse(init.body) as Record<string, unknown> });
        return { ok: true, status: 204, headers: { get: () => null }, text: async () => '' };
      },
      [0, 0],
      { coalesceMs: 60_000 },
    );
    updateGeneralSettings(t.ctx, { ticketFormat: '{YY}{MM}{DD}-{N}', appUrl: 'https://tower.example', claudeModel: '' });
    updateDiscordSettings(t.ctx, { webhookUrl: WEBHOOK, events: { external: false, critical: false, digest: false, blocked: false } });
    updateChannelSettings(t.ctx, 'ntfy', { url: 'https://push.example/ntfy/install-topic?auth=x', secret: 'tk_install', events: { external: false, critical: false, digest: false, blocked: false } });
    t.ctx.db
      .prepare('UPDATE users SET discord_user_id = ?, ntfy_topic = ?, notify_prefs = ? WHERE id = ?')
      .run(BOB_DISCORD, 'belltower-bob-x7Kq2', JSON.stringify({ assigned: everywhere, mentioned: everywhere, watching: everywhere }), people.bob!);
  });

  /** Hands the events so far to the notifier, as index.ts does after each commit, then sends what's waiting. */
  async function deliver() {
    for (const e of events.splice(0)) await notifier.handle(t.ctx, e);
    await notifier.flushPersonal(t.ctx);
  }

  it('Discord: mentions the person in the install’s channel, and only them', async () => {
    const card = createCard(t.ctx, { title: 'Disk 3 @everyone *SMART*' });
    updateCard(as('alice'), card.id, { assigneeId: people.bob! });
    await deliver();
    const discord = sent.filter((s) => s.url === WEBHOOK);
    expect(discord).toHaveLength(1);
    expect(discord[0]!.json).toEqual({
      username: 'Belltower',
      content: `<@${BOB_DISCORD}> Alice assigned this to you · **${card.ticketNo} — Disk 3 @everyone \\*SMART\\*** <https://tower.example/cards/${card.id}>`,
      allowed_mentions: { parse: [], users: [BOB_DISCORD] },
    });
  });

  it('ntfy: the person’s own topic on the install’s server, with the install’s token', async () => {
    const card = createCard(t.ctx, { title: 'Router [reboot]' });
    addWorklog(as('alice'), card.id, { bodyMd: 'Can you look, @bob?' });
    await deliver();
    const ntfy = sent.filter((s) => s.url.startsWith('https://push.example'));
    expect(ntfy).toHaveLength(1);
    expect(ntfy[0]!.url).toBe('https://push.example/ntfy/?auth=x');
    expect(ntfy[0]!.headers.Authorization).toBe('Bearer tk_install');
    expect(ntfy[0]!.json).toEqual({
      topic: 'belltower-bob-x7Kq2',
      title: `${card.ticketNo} — Router [reboot]`,
      message: 'Alice mentioned you: “Can you look, @bob?”',
      priority: 3,
      markdown: true,
      click: `https://tower.example/cards/${card.id}`,
    });
  });

  it('combines a move-many into one Discord and one ntfy message per person', async () => {
    const cards = [1, 2, 3].map((i) => createCard(t.ctx, { title: `Card ${i}` }));
    for (const c of cards) watchCard(t.ctx, c.id, people.bob!);
    moveCards(as('alice'), cards.map((c) => c.id), { toColumnId: columnId(t.ctx, 'In Progress'), afterCardId: null });
    expect(events.filter((e) => e.type === 'people_notified')).toHaveLength(3);
    await deliver();
    expect(sent).toHaveLength(2);
    const discord = sent.find((s) => s.url === WEBHOOK)!;
    const content = discord.json.content as string;
    expect(content.split('\n')[0]).toBe(`<@${BOB_DISCORD}> 3 updates in Belltower:`);
    expect(content.split('\n')).toHaveLength(4);
    expect(content).toContain(`• Alice moved this to In Progress · **${cards[0]!.ticketNo} — Card 1** <https://tower.example/cards/${cards[0]!.id}>`);
    const ntfy = sent.find((s) => s.url.startsWith('https://push.example'))!;
    expect(ntfy.json.title).toBe('3 updates in Belltower');
    expect(ntfy.json.click).toBeUndefined();
    expect((ntfy.json.message as string).split('\n')).toHaveLength(3);
  });

  it('waits the coalescing window, then sends on its own', async () => {
    const quick = new Notifier(
      async (url, init) => {
        sent.push({ url, headers: init.headers, json: JSON.parse(init.body) as Record<string, unknown> });
        return { ok: true, status: 204, headers: { get: () => null }, text: async () => '' };
      },
      [0, 0],
      { coalesceMs: 30 },
    );
    const card = createCard(t.ctx, { title: 'Timer' });
    updateCard(as('alice'), card.id, { assigneeId: people.bob! });
    for (const e of events.splice(0)) await quick.handle(t.ctx, e);
    expect(sent).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 120));
    expect(sent).toHaveLength(2);
  });

  it('only holds notifications for people with a Discord ID or an ntfy topic', async () => {
    const card = createCard(t.ctx, { title: 'Queue' });
    updateCard(as('alice'), card.id, { assigneeId: people.carol! }); // Carol has neither
    for (const e of events.splice(0)) await notifier.handle(t.ctx, e);
    expect(notifier.waitingPeople).toBe(0);
    updateCard(as('alice'), card.id, { assigneeId: people.bob! });
    for (const e of events.splice(0)) await notifier.handle(t.ctx, e);
    expect(notifier.waitingPeople).toBe(1);
    await notifier.flushPersonal(t.ctx);
    expect(notifier.waitingPeople).toBe(0);
  });

  it('only on the channels picked for that event, and only once the person has an ID or topic', async () => {
    t.ctx.db
      .prepare('UPDATE users SET notify_prefs = ?, ntfy_topic = NULL WHERE id = ?')
      .run(JSON.stringify({ assigned: { inApp: true, discord: false, ntfy: true }, watching: { inApp: true, discord: true, ntfy: true } }), people.bob!);
    const card = createCard(t.ctx, { title: 'Picky' });
    updateCard(as('alice'), card.id, { assigneeId: people.bob! });
    await deliver();
    expect(sent).toEqual([]); // assigned: ntfy only, and there's no topic
    addWorklog(as('alice'), card.id, { bodyMd: 'Note' });
    await deliver();
    expect(sent.map((s) => s.url)).toEqual([WEBHOOK]);
  });

  it('a rolled-back change sends nothing, and a deactivated person gets nothing', async () => {
    const card = createCard(t.ctx, { title: 'Rollback' });
    expect(() =>
      t.ctx.db.transaction(() => {
        updateCard(as('alice'), card.id, { assigneeId: people.bob! });
        throw new Error('nope');
      })(),
    ).toThrow('nope');
    await deliver();
    expect(sent).toEqual([]);
    updateCard(as('alice'), card.id, { assigneeId: people.bob! });
    for (const e of events.splice(0)) await notifier.handle(t.ctx, e);
    updateUser(t.ctx, people.bob!, { disabled: true }, { ownerPasswordFromEnv: false });
    await notifier.flushPersonal(t.ctx);
    expect(sent).toEqual([]);
  });

  it('never publishes to a topic outside belltower-…, or to the install’s own (say, from a restored backup)', async () => {
    t.ctx.db.prepare('UPDATE users SET ntfy_topic = ? WHERE id = ?').run('someone-elses-topic', people.bob!);
    const card = createCard(t.ctx, { title: 'Sneaky' });
    updateCard(as('alice'), card.id, { assigneeId: people.bob! });
    await deliver();
    expect(sent.map((s) => s.url)).toEqual([WEBHOOK]);
    expect((await notifier.sendPersonalTest(t.ctx, people.bob!)).ntfy).toEqual({ ok: false, message: expect.stringMatching(/start with belltower-/) });
    updateChannelSettings(t.ctx, 'ntfy', { url: 'https://push.example/ntfy/belltower-shared', secret: null, events: { external: false, critical: false, digest: false, blocked: false } });
    t.ctx.db.prepare('UPDATE users SET ntfy_topic = ? WHERE id = ?').run('belltower-shared', people.bob!);
    expect((await notifier.sendPersonalTest(t.ctx, people.bob!)).ntfy!.ok).toBe(false);
  });

  it('Send me a test: each channel filled in, explaining when the install has no such channel', async () => {
    expect(await notifier.sendPersonalTest(t.ctx, people.bob!)).toEqual({
      discord: { ok: true, message: 'Delivered' },
      ntfy: { ok: true, message: 'Delivered' },
    });
    expect(sent[0]!.json.allowed_mentions).toEqual({ parse: [], users: [BOB_DISCORD] });
    expect(sent.find((s) => s.json.topic === 'belltower-bob-x7Kq2')!.json.title).toBe('Belltower test message');
    updateDiscordSettings(t.ctx, { webhookUrl: '', events: { external: false, critical: false, digest: false, blocked: false } });
    updateChannelSettings(t.ctx, 'ntfy', { url: '', secret: '', events: { external: false, critical: false, digest: false, blocked: false } });
    const r = await notifier.sendPersonalTest(t.ctx, people.bob!);
    expect(r.discord).toEqual({ ok: false, message: expect.stringMatching(/no Discord channel yet/) });
    expect(r.ntfy).toEqual({ ok: false, message: expect.stringMatching(/no ntfy channel yet/) });
    expect(await notifier.sendPersonalTest(t.ctx, people.carol!)).toEqual({ discord: null, ntfy: null });
  });

  it('leaves the install channels alone: their events, the webhook payload and their last delivery', async () => {
    expect(WEBHOOK_EVENTS).toEqual(['new_external', 'new_urgent', 'raised', 'blocked', 'digest', 'test']);
    updateChannelSettings(t.ctx, 'webhook', { url: 'https://hooks.example/in', secret: null, events: { external: true, critical: true, digest: true, blocked: true } });
    const card = createCard(t.ctx, { title: 'Quiet for the webhook' });
    updateCard(as('alice'), card.id, { assigneeId: people.bob! });
    moveCard(as('alice'), card.id, { toColumnId: columnId(t.ctx, 'In Progress'), afterCardId: null });
    addWorklog(as('alice'), card.id, { bodyMd: '@bob look' });
    await deliver();
    expect(sent.filter((s) => s.url.startsWith('https://hooks.example'))).toEqual([]);
    expect(t.ctx.db.prepare("SELECT count(*) FROM settings WHERE key LIKE '%_last_delivery'").pluck().get()).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Over HTTP
// ---------------------------------------------------------------------------------------------

describe('over HTTP', () => {
  let app: TestApp | undefined;
  afterEach(async () => {
    await app?.shutdown();
    app = undefined;
  });

  it('a mention reaches the member’s bell; they open it and mark it read; nobody sees anyone else’s', async () => {
    app = await makeApp();
    const admin = await setupAndLogin(app);
    expect((await client(app.app, admin)('PUT', '/api/settings/teams', { enabled: true })).statusCode).toBe(200);
    const sam = await addPerson(app, admin, 'sam');
    const asAdmin = client(app.app, admin);
    const asSam = client(app.app, sam.cookie);
    const card = (await asAdmin('POST', '/api/cards', { title: 'Garage door sensor' })).json();
    expect(card.watching).toBe(true);
    expect((await asSam('GET', `/api/cards/${card.id}`)).json().watching).toBe(false);
    expect((await asAdmin('POST', `/api/cards/${card.id}/worklog`, { bodyMd: 'Battery swapped. @sam can you test it?' })).statusCode).toBe(201);

    const list = (await asSam('GET', '/api/notifications')).json();
    expect(list).toMatchObject({ unread: 1, items: [{ type: 'mentioned', cardId: card.id, cardTitle: 'Garage door sensor', actorName: 'admin', readAt: null }] });
    expect(list.items[0].text).toBe('admin mentioned you: “Battery swapped. @sam can you test it?”');
    expect((await asAdmin('GET', '/api/notifications')).json()).toMatchObject({ unread: 0, items: [] });
    // Someone else's id does nothing.
    expect((await asAdmin('POST', '/api/notifications/read', { ids: [list.items[0].id] })).json()).toEqual({ unread: 0 });
    expect((await asSam('GET', '/api/notifications?limit=5')).json().unread).toBe(1);
    expect((await asSam('POST', '/api/notifications/read', { ids: [list.items[0].id] })).json()).toEqual({ unread: 0 });
    expect((await asSam('POST', '/api/notifications/read', {})).statusCode).toBe(400);
    expect((await asSam('GET', `/api/notifications?after=${list.latestId}`)).json().items).toEqual([]);
  });

  it('the bell’s poll doesn’t keep an idle session alive past its 12-hour timeout', async () => {
    app = await makeApp();
    await setupAndLogin(app);
    const polled = client(app.app, await loginAs(app, 'admin')); // not remembered: 12 hours idle
    const used = client(app.app, await loginAs(app, 'admin'));
    const halfHour = 30 * 60 * 1000;
    for (let i = 1; i <= 23; i++) {
      app.clock.advance(halfHour);
      expect((await polled('GET', '/api/notifications')).statusCode, `poll ${i}`).toBe(200);
      expect((await used('GET', '/api/board')).statusCode, `board ${i}`).toBe(200);
    }
    app.clock.advance(2 * halfHour); // 12.5 hours after signing in, with only polls in between
    expect((await polled('GET', '/api/notifications')).statusCode).toBe(401);
    expect((await used('GET', '/api/notifications')).statusCode).toBe(200); // real use slides it
  });

  it('watch and unwatch a card', async () => {
    app = await makeApp();
    const admin = await setupAndLogin(app);
    const sam = await addPerson(app, admin, 'sam');
    const asSam = client(app.app, sam.cookie);
    const card = (await client(app.app, admin)('POST', '/api/cards', { title: 'Watch me' })).json();
    expect((await asSam('PUT', `/api/cards/${card.id}/watch`)).json()).toEqual({ watching: true });
    expect((await asSam('GET', `/api/cards/${card.id}`)).json().watching).toBe(true);
    expect((await asSam('PUT', `/api/cards/${card.id}/watch`)).json()).toEqual({ watching: true }); // twice is fine
    expect((await asSam('DELETE', `/api/cards/${card.id}/watch`)).json()).toEqual({ watching: false });
    expect((await asSam('GET', `/api/cards/${card.id}`)).json().watching).toBe(false);
    expect((await asSam('PUT', '/api/cards/99999/watch')).statusCode).toBe(404);
  });

  it('your channels and prefs: saved, validated, and the test button explains and is limited', async () => {
    const sent: string[] = [];
    const notifier = new Notifier(async (url) => {
      sent.push(url);
      return { ok: true, status: 204, headers: { get: () => null }, text: async () => '' };
    }, [0, 0]);
    app = await makeApp({ notifier });
    const admin = await setupAndLogin(app);
    const sam = await addPerson(app, admin, 'sam');
    const asSam = client(app.app, sam.cookie);

    expect((await asSam('GET', '/api/me/notifications')).json()).toEqual({
      discordUserId: null,
      ntfyTopic: null,
      prefs: DEFAULT_NOTIFY_PREFS,
      install: { discord: false, ntfy: false },
    });
    expect((await asSam('POST', '/api/me/notifications/test')).json()).toMatchObject({ error: 'nothing_to_test' });

    const prefs = { ...DEFAULT_NOTIFY_PREFS, mentioned: { inApp: true, discord: true, ntfy: false } };
    for (const bad of [
      { discordUserId: '1234', ntfyTopic: null, prefs },
      { discordUserId: null, ntfyTopic: 'has space', prefs },
      { discordUserId: null, ntfyTopic: 'my-own-topic', prefs }, // not belltower-…
      { discordUserId: null, ntfyTopic: `belltower-${'x'.repeat(55)}`, prefs },
      { discordUserId: null, ntfyTopic: null, prefs: { assigned: { inApp: 'yes' } } },
    ]) {
      expect((await asSam('PUT', '/api/me/notifications', bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    const saved = (await asSam('PUT', '/api/me/notifications', { discordUserId: ' 123456789012345678 ', ntfyTopic: 'belltower-sam_1', prefs })).json();
    expect(saved).toMatchObject({ discordUserId: '123456789012345678', ntfyTopic: 'belltower-sam_1', prefs });

    // The install has neither channel: the test says so instead of sending.
    const result = (await asSam('POST', '/api/me/notifications/test')).json();
    expect(result.discord.ok).toBe(false);
    expect(result.discord.message).toMatch(/Settings → Notifications/);
    expect(sent).toEqual([]);
    for (let i = 0; i < 4; i++) expect((await asSam('POST', '/api/me/notifications/test')).statusCode).toBe(200);
    expect((await asSam('POST', '/api/me/notifications/test')).statusCode).toBe(429);

    // Someone else's settings stay theirs.
    expect((await client(app.app, admin)('GET', '/api/me/notifications')).json().discordUserId).toBeNull();

    // The install's own topic is refused, even though it has the prefix.
    const events = { external: true, critical: true, digest: false, blocked: false };
    expect((await client(app.app, admin)('PUT', '/api/settings/notify/ntfy', { url: 'https://ntfy.sh/belltower-install', secret: null, events })).statusCode).toBe(200);
    const own = await asSam('PUT', '/api/me/notifications', { discordUserId: null, ntfyTopic: 'belltower-install', prefs });
    expect(own.statusCode).toBe(400);
    expect(own.json().message).toMatch(/install’s own ntfy topic/);
  });
});

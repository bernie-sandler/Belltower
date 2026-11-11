// 1.5 assignees: one person per card, set on create or by editing, logged as `assigned` and
// announced as a `card_assigned` event (for personal notifications); deactivated people can't be
// given cards, and two people taking the same card can't both win.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listActivity } from '../src/services/activity';
import { createCard, getBoard, getCard, updateCard } from '../src/services/cards';
import { withActor, type AppEvent } from '../src/services/context';
import { Notifier } from '../src/services/notify';
import { getChannelSettings, updateChannelSettings, updateDiscordSettings } from '../src/services/settings';
import { createUser } from '../src/services/users';
import { addPerson, client, enableTeams, makeApp, makeCtx, setupAndLogin, type TestApp } from './helpers';

describe('assigning cards (service)', () => {
  let t: ReturnType<typeof makeCtx>;
  let alice: number;
  let bob: number;
  let events: AppEvent[];
  beforeEach(() => {
    t = makeCtx();
    alice = createUser(t.ctx, { username: 'alice', displayName: 'Alice', role: 'member' }, 'hash').id;
    bob = createUser(t.ctx, { username: 'bob', displayName: 'Bob', role: 'member' }, 'hash').id;
    events = [];
    t.ctx.emit = (e) => events.push(e);
  });
  afterEach(() => t.close());

  const assignedEntries = (cardId: number) => listActivity(t.ctx, cardId).filter((e) => e.type === 'assigned');

  it('assigns, reassigns and unassigns: one history entry and one event each, with the actor', () => {
    const card = createCard(t.ctx, { title: 'Fans loud' });
    expect(card.assigneeId).toBeNull();
    const asBob = withActor(t.ctx, { kind: 'user', userId: bob });

    const assigned = updateCard(asBob, card.id, { assigneeId: alice, expectedVersion: card.version });
    expect(assigned).toMatchObject({ assigneeId: alice, version: card.version + 1 });
    expect(getBoard(t.ctx).cards.find((c) => c.id === card.id)?.assigneeId).toBe(alice);
    expect(assignedEntries(card.id)).toMatchObject([{ data: { from: null, to: alice, fromName: null, toName: 'Alice' }, userId: bob, tokenId: null }]);
    expect(events.filter((e) => e.type === 'card_assigned')).toEqual([
      { type: 'card_assigned', cardId: card.id, from: null, to: alice, actor: { kind: 'user', userId: bob } },
    ]);

    // Taking it yourself: the entry's person is the new assignee ("took this").
    updateCard(asBob, card.id, { assigneeId: bob });
    expect(assignedEntries(card.id)[0]).toMatchObject({ data: { from: alice, to: bob, fromName: 'Alice', toName: 'Bob' }, userId: bob });

    const cleared = updateCard(asBob, card.id, { assigneeId: null });
    expect(cleared.assigneeId).toBeNull();
    expect(assignedEntries(card.id)[0]).toMatchObject({ data: { from: bob, to: null, fromName: 'Bob', toName: null } });
    expect(events.filter((e) => e.type === 'card_assigned').map((e) => [e.type === 'card_assigned' && e.from, e.type === 'card_assigned' && e.to])).toEqual([
      [null, alice],
      [alice, bob],
      [bob, null],
    ]);
  });

  it('edits that leave assigneeId out keep the assignee', () => {
    const card = createCard(t.ctx, { title: 'Fans loud', assigneeId: alice });
    events = [];
    const edited = updateCard(t.ctx, card.id, { title: 'Fans very loud', priority: 'high', expectedVersion: card.version });
    expect(edited).toMatchObject({ assigneeId: alice, title: 'Fans very loud' });
    expect(getCard(t.ctx, card.id).assigneeId).toBe(alice);
    expect(assignedEntries(card.id)).toHaveLength(1); // only the one from creating it
    expect(events.filter((e) => e.type === 'card_assigned')).toEqual([]);
  });

  it('assigning the same person again changes nothing', () => {
    const card = createCard(t.ctx, { title: 'Fans loud' });
    const v = updateCard(t.ctx, card.id, { assigneeId: alice }).version;
    events = [];
    expect(updateCard(t.ctx, card.id, { assigneeId: alice }).version).toBe(v);
    expect(assignedEntries(card.id)).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it('creates a card with an assignee, logged like an assignment', () => {
    enableTeams(t.ctx); // personal notifications are a team feature
    const card = createCard(withActor(t.ctx, { kind: 'user', userId: alice }), { title: 'Replace UPS battery', assigneeId: bob });
    expect(getCard(t.ctx, card.id).assigneeId).toBe(bob);
    expect(assignedEntries(card.id)).toMatchObject([{ data: { from: null, to: bob, toName: 'Bob' }, userId: alice }]);
    // Bob hears about it (people_notified carries his notification to his personal channels).
    expect(events.map((e) => e.type)).toEqual(['card_created', 'card_assigned', 'people_notified']);
  });

  it('refuses unknown and deactivated people, but a deactivated assignee can still be taken off', () => {
    const card = createCard(t.ctx, { title: 'Fans loud', assigneeId: alice });
    t.ctx.db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run('2026-10-10T15:00:00.000Z', alice);
    const v = getCard(t.ctx, card.id).version;

    expect(() => updateCard(t.ctx, card.id, { assigneeId: 9999 })).toThrow(expect.objectContaining({ status: 400, code: 'invalid_assignee' }));
    t.ctx.db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run('2026-10-10T15:00:00.000Z', bob);
    expect(() => updateCard(t.ctx, card.id, { assigneeId: bob })).toThrow(expect.objectContaining({ status: 400, code: 'assignee_disabled' }));
    expect(() => createCard(t.ctx, { title: 'New', assigneeId: bob })).toThrow(expect.objectContaining({ code: 'assignee_disabled' }));
    expect(getCard(t.ctx, card.id)).toMatchObject({ assigneeId: alice, version: v });

    // Keeping them (no change) is fine, and so is taking them off.
    expect(updateCard(t.ctx, card.id, { assigneeId: alice, title: 'Fans very loud' }).assigneeId).toBe(alice);
    expect(updateCard(t.ctx, card.id, { assigneeId: null }).assigneeId).toBeNull();
  });
});

describe('assigning cards (API)', () => {
  let t: TestApp | undefined;
  afterEach(async () => {
    await t?.shutdown();
    t = undefined;
  });

  it('a PATCH without assigneeId (a title only) keeps the assignee', async () => {
    t = await makeApp();
    const admin = await setupAndLogin(t);
    const sam = await addPerson(t, admin, 'sam');
    const c = client(t.app, admin);
    const card = (await c('POST', '/api/cards', { title: 'Fans loud', assigneeId: sam.id })).json();
    const res = await c('PATCH', `/api/cards/${card.id}`, { title: 'Fans very loud', expectedVersion: card.version });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ title: 'Fans very loud', assigneeId: sam.id });
  });

  it('PATCH sets the assignee; unknown and deactivated people get a clear 400', async () => {
    t = await makeApp();
    const admin = await setupAndLogin(t);
    const sam = await addPerson(t, admin, 'sam');
    const kim = await addPerson(t, admin, 'kim');
    const c = client(t.app, admin);
    const card = (await c('POST', '/api/cards', { title: 'Fans loud', assigneeId: sam.id })).json();
    expect(card.assigneeId).toBe(sam.id);

    expect((await c('PATCH', `/api/users/${kim.id}`, { disabled: true })).statusCode).toBe(200);
    const disabled = await c('PATCH', `/api/cards/${card.id}`, { assigneeId: kim.id, expectedVersion: card.version });
    expect(disabled.statusCode).toBe(400);
    expect(disabled.json()).toMatchObject({ error: 'assignee_disabled' });
    expect(disabled.json().message).toContain('kim');
    const unknown = await c('PATCH', `/api/cards/${card.id}`, { assigneeId: 4242, expectedVersion: card.version });
    expect(unknown.json()).toMatchObject({ error: 'invalid_assignee' });
    expect((await c('POST', '/api/cards', { title: 'Nope', assigneeId: kim.id })).json()).toMatchObject({ error: 'assignee_disabled' });
    expect((await c('PATCH', `/api/cards/${card.id}`, { assigneeId: 0, expectedVersion: card.version })).statusCode).toBe(400);

    const cleared = await c('PATCH', `/api/cards/${card.id}`, { assigneeId: null, expectedVersion: card.version });
    expect(cleared.json()).toMatchObject({ assigneeId: null, version: card.version + 1 });
    const board = (await c('GET', '/api/board')).json();
    expect(board.cards.find((x: { id: number }) => x.id === card.id).assigneeId).toBeNull();
  });

  it('Add ticket takes an assignee too', async () => {
    t = await makeApp();
    const admin = await setupAndLogin(t);
    const sam = await addPerson(t, admin, 'sam');
    const res = await client(t.app, admin)('POST', '/api/tickets', { title: 'Plex buffering', assigneeId: sam.id });
    expect(res.statusCode).toBe(201);
    expect(res.json().assigneeId).toBe(sam.id);
  });

  it('two people taking the same card: one wins, the other gets 409 with the winner’s copy', async () => {
    t = await makeApp();
    const admin = await setupAndLogin(t);
    const sam = await addPerson(t, admin, 'sam');
    const kim = await addPerson(t, admin, 'kim');
    const card = (await client(t.app, admin)('POST', '/api/cards', { title: 'Printer jammed' })).json();

    const [a, b] = await Promise.all([
      client(t.app, sam.cookie)('PATCH', `/api/cards/${card.id}`, { assigneeId: sam.id, expectedVersion: card.version }),
      client(t.app, kim.cookie)('PATCH', `/api/cards/${card.id}`, { assigneeId: kim.id, expectedVersion: card.version }),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const [won, lost] = a.statusCode === 200 ? [a, b] : [b, a];
    const winner = won === a ? sam.id : kim.id;
    expect(lost.json()).toMatchObject({ error: 'version_conflict', card: { assigneeId: winner } });

    const history = (await client(t.app, admin)('GET', `/api/cards/${card.id}/activity`)).json() as { type: string; userId: number; data: { to: number } }[];
    const assigned = history.filter((e) => e.type === 'assigned');
    expect(assigned).toHaveLength(1);
    expect(assigned[0]).toMatchObject({ userId: winner, data: { to: winner } }); // took it
  });
});

describe('the install’s notification channels ignore assignments', () => {
  let t: ReturnType<typeof makeCtx>;
  afterEach(() => t.close());

  it('sends nothing for card_assigned or a type it doesn’t know (Discord and the webhook), and doesn’t throw', async () => {
    t = makeCtx();
    const sent: unknown[] = [];
    const notifier = new Notifier(async (_url, init) => {
      sent.push(init.body);
      return { ok: true, status: 204, headers: { get: () => null }, text: async () => '' };
    }, [0, 0]);
    updateDiscordSettings(t.ctx, {
      webhookUrl: 'https://discord.com/api/webhooks/1/abc',
      events: { external: true, critical: true, digest: true, blocked: true },
      digestTime: '08:00',
    });
    updateChannelSettings(t.ctx, 'webhook', {
      url: 'https://hooks.example/in/abc123',
      secret: 'whsec',
      events: { external: true, critical: true, digest: true, blocked: true },
    });
    expect(getChannelSettings(t.ctx, 'webhook').url).toBe('https://hooks.example/in/abc123');
    const card = createCard(t.ctx, { title: 'Array offline', priority: 'critical', severity: 'blocker' });
    await notifier.handle(t.ctx, { type: 'card_assigned', cardId: card.id, from: null, to: 1 });
    await notifier.handle(t.ctx, { type: 'card_watched', cardId: card.id } as unknown as AppEvent);
    expect(sent).toEqual([]);
    // Both channels are live: an urgent new card reaches both.
    await notifier.handle(t.ctx, { type: 'card_created', cardId: card.id, external: false });
    expect(sent).toHaveLength(2);
  });
});

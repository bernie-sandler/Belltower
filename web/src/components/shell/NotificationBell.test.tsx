// The bell: polls every 30 seconds (background tabs too), rings only when the unread count rises
// from a known baseline, in one tab only, and opening an item opens its card and marks it read.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { NotificationItem, NotificationsResponse } from '@tt/shared';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BELL_POLL_MS } from '../../api/notifications';
import { LAST_ID_KEY, playSound, resetSoundForTests, setSound } from '../../lib/sound';
import { CLAIM_JITTER_MS, NotificationBell } from './NotificationBell';

vi.mock('../../lib/sound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/sound')>();
  return { ...actual, playSound: vi.fn(() => true) };
});

const item = (id: number, over: Partial<NotificationItem> = {}): NotificationItem => ({
  id,
  type: 'mentioned',
  cardId: 40 + id,
  ticketNo: `261110-${id}`,
  cardTitle: `Card ${id}`,
  actorName: 'Alex Chen',
  text: `Alex Chen mentioned you (${id})`,
  createdAt: '2026-11-10T15:00:00.000Z',
  readAt: null,
  ...over,
});
const answer = (items: NotificationItem[]): NotificationsResponse => ({
  items,
  unread: items.filter((n) => !n.readAt).length,
  latestId: Math.max(0, ...items.map((n) => n.id)),
});

let polls: NotificationsResponse[];
let fetchMock: ReturnType<typeof vi.fn>;

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

/** A fake server: answers the polls in turn, remembering what was marked read. */
function setup() {
  let served = 0;
  let allRead = false;
  const readIds = new Set<number>();
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const current = () => {
    const base = polls[Math.min(served++, polls.length - 1)]!;
    return answer(base.items.map((n) => (allRead || readIds.has(n.id) ? { ...n, readAt: n.readAt ?? '2026-11-10T15:05:00.000Z' } : n)));
  };
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/notifications/read') {
      const body = JSON.parse(String(init!.body)) as { ids?: number[]; all?: boolean };
      if (body.all) allRead = true;
      for (const id of body.ids ?? []) readIds.add(id);
      return json({ unread: current().unread });
    }
    if (url.startsWith('/api/notifications')) return json(current());
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <NotificationBell />
        <Routes>
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { pollCount: () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/notifications?')).length };
}

/** Lets timers (the poll, the jitter) and the fetches they start run. */
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const bellName = () => screen.getByRole('button', { name: /^Notifications/ }).getAttribute('aria-label');

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  resetSoundForTests();
  vi.mocked(playSound).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('NotificationBell', () => {
  it('polls every 30 seconds and rings once when the count rises, never on first load', async () => {
    polls = [answer([item(1)]), answer([item(1)]), answer([item(2), item(1)])];
    const { pollCount } = setup();
    await advance(0);
    expect(bellName()).toBe('Notifications, 1 unread');
    await advance(CLAIM_JITTER_MS);
    expect(playSound).not.toHaveBeenCalled(); // what was there at load is the baseline

    await advance(BELL_POLL_MS);
    expect(pollCount()).toBe(2);
    expect(playSound).not.toHaveBeenCalled(); // nothing new

    await advance(BELL_POLL_MS);
    expect(pollCount()).toBe(3);
    expect(bellName()).toBe('Notifications, 2 unread');
    expect(screen.getByTestId('bell-count').textContent).toBe('2');
    await advance(CLAIM_JITTER_MS);
    expect(playSound).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(LAST_ID_KEY)).toBe('2');

    await advance(BELL_POLL_MS); // same answer again: no second ring
    await advance(CLAIM_JITTER_MS);
    expect(playSound).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when another tab already rang for it, or the sound is off', async () => {
    polls = [answer([item(1)]), answer([item(2), item(1)]), answer([item(3), item(2), item(1)])];
    setup();
    await advance(0);
    // Another tab claims notification 2 first (it hears about it through the storage event).
    localStorage.setItem(LAST_ID_KEY, '2');
    window.dispatchEvent(new StorageEvent('storage', { key: LAST_ID_KEY, newValue: '2' }));
    await advance(BELL_POLL_MS + CLAIM_JITTER_MS);
    expect(bellName()).toBe('Notifications, 2 unread');
    expect(playSound).not.toHaveBeenCalled();

    setSound('off');
    await advance(BELL_POLL_MS + CLAIM_JITTER_MS);
    expect(bellName()).toBe('Notifications, 3 unread');
    expect(playSound).not.toHaveBeenCalled();
  });

  it('doesn’t ring when the count only goes down, and rings again for something new after that', async () => {
    polls = [answer([item(2), item(1)]), answer([item(2), item(1, { readAt: '2026-11-10T15:01:00.000Z' })]), answer([item(3), item(2), item(1, { readAt: '2026-11-10T15:01:00.000Z' })])];
    setup();
    await advance(0);
    await advance(BELL_POLL_MS + CLAIM_JITTER_MS);
    expect(bellName()).toBe('Notifications, 1 unread');
    expect(playSound).not.toHaveBeenCalled();
    await advance(BELL_POLL_MS + CLAIM_JITTER_MS);
    expect(bellName()).toBe('Notifications, 2 unread');
    expect(playSound).toHaveBeenCalledTimes(1);
  });

  it('opens a notification’s card and marks it read; Mark all read clears the count', async () => {
    polls = [answer([item(2), item(1)])];
    setup();
    await advance(0);
    fireEvent.click(screen.getByRole('button', { name: 'Notifications, 2 unread' }));
    const dialog = screen.getByRole('dialog', { name: 'Notifications' });
    expect(dialog.textContent).toContain('261110-2 — Card 2');
    fireEvent.click(screen.getByRole('button', { name: /Alex Chen mentioned you \(2\)/ }));
    await advance(50);
    const read = fetchMock.mock.calls.filter(([url]) => url === '/api/notifications/read').map(([, init]) => JSON.parse(String(init.body)));
    expect(read).toEqual([{ ids: [2] }]);
    expect(screen.getByTestId('where').textContent).toBe('/cards/42');
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^Notifications/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    await advance(50);
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/notifications/read').map(([, init]) => JSON.parse(String(init.body)))).toEqual([
      { ids: [2] },
      { all: true },
    ]);
    expect(bellName()).toBe('Notifications');
  });

  it('says so when there is nothing yet', async () => {
    polls = [answer([])];
    setup();
    await advance(0);
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
    expect(screen.getByText(/Nothing yet/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Mark all read' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

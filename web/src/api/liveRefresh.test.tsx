// Live refresh: every 15 seconds while the tab is visible (and at once when it comes back), the bell
// and everything that shows tickets refetch, but never mid-drag or while a change is on its way.

import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDragging } from '../lib/dragging';
import { toast } from '../lib/toast';
import { BOARD_ORDER_KEY, BOARD_ORDER_SCOPE, flushBoardRefetch } from './board';
import { qk } from './keys';
import { holdLiveRefresh, LIVE_REFRESH_MS, liveRefreshBlocked, liveRefreshTick, refreshForNews, useLiveRefresh } from './liveRefresh';
import { queryClient } from './queryClient';

vi.mock('../lib/toast', () => ({ toast: vi.fn() }));

let visibility: DocumentVisibilityState = 'visible';
beforeAll(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});
afterAll(() => {
  delete (document as { visibilityState?: unknown }).visibilityState;
});

function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
}

const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

let unmount: (() => void) | undefined;

/** The hook in its own client; `keys()` lists what was invalidated, `ticks()` how many times the bell's list was. */
function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  unmount = renderHook(() => useLiveRefresh(), { wrapper }).unmount;
  const keys = () => invalidate.mock.calls.map(([filters]) => filters?.queryKey);
  const ticks = () => keys().filter((k) => k?.[0] === 'notifications').length;
  return { qc, invalidate, keys, ticks };
}

/** A board-order operation (a move) that stays on its way until `finish()`. */
function pendingMove(qc: QueryClient) {
  let finish = () => {};
  const vars = { cardId: 1, toColumnId: 2, afterCardId: null };
  const mutation = qc.getMutationCache().build(qc, {
    mutationKey: [...BOARD_ORDER_KEY, 'move'],
    scope: BOARD_ORDER_SCOPE,
    mutationFn: () => new Promise<void>((resolve) => (finish = resolve)),
  });
  void mutation.execute(vars);
  return { vars, finish: () => finish() };
}

/** An observed (active) board query; `fetches()` counts its requests. */
function watchBoard(qc: QueryClient, answer: () => Promise<unknown> = async () => ({ cards: [] })) {
  let fetches = 0;
  const observer = new QueryObserver(qc, {
    queryKey: qk.board,
    queryFn: () => {
      fetches++;
      return answer();
    },
  });
  const stop = observer.subscribe(() => {});
  return { fetches: () => fetches, stop };
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  vi.mocked(toast).mockClear();
});

afterEach(() => {
  unmount?.();
  unmount = undefined;
  setDragging(false);
  vi.useRealTimers();
});

describe('useLiveRefresh', () => {
  it('every 15 seconds refetches the bell and everything that shows tickets, without cutting a fetch short', async () => {
    const { qc, invalidate, keys } = setup();
    const board = watchBoard(qc);
    await advance(0);
    expect(board.fetches()).toBe(1);

    await advance(LIVE_REFRESH_MS - 1);
    expect(invalidate).not.toHaveBeenCalled();
    await advance(1);
    expect(keys()).toEqual([qk.notifications, qk.board, qk.cardLists, qk.calendars, qk.cards, qk.activities]);
    for (const [, options] of invalidate.mock.calls) expect(options).toEqual({ cancelRefetch: false });
    expect(board.fetches()).toBe(2); // only queries on screen actually refetch

    await advance(LIVE_REFRESH_MS);
    expect(board.fetches()).toBe(3);
    board.stop();
  });

  it('skips ticks while the tab is hidden, and refreshes at once when it’s back', async () => {
    const { ticks } = setup();
    setVisibility('hidden');
    await advance(LIVE_REFRESH_MS * 2 + 5_000);
    expect(ticks()).toBe(0);

    setVisibility('visible');
    expect(ticks()).toBe(1);
    // The next tick counts from now (the old schedule would have fired 10 seconds from here).
    await advance(LIVE_REFRESH_MS - 1);
    expect(ticks()).toBe(1);
    await advance(1);
    expect(ticks()).toBe(2);
  });

  it('skips ticks mid-drag', async () => {
    const { ticks } = setup();
    setDragging(true);
    await advance(LIVE_REFRESH_MS);
    expect(ticks()).toBe(0);
    // Becoming visible mid-drag doesn't refresh either.
    setVisibility('visible');
    expect(ticks()).toBe(0);
    setDragging(false);
    await advance(LIVE_REFRESH_MS);
    expect(ticks()).toBe(1);
  });

  it('skips ticks while a board-order operation is on its way', async () => {
    const { qc, ticks } = setup();
    const move = pendingMove(qc);
    await advance(LIVE_REFRESH_MS * 2);
    expect(ticks()).toBe(0);
    move.finish();
    await advance(LIVE_REFRESH_MS);
    expect(ticks()).toBe(1);
  });

  it('skips ticks while held (a checklist mark waiting to be saved); releasing twice is harmless', async () => {
    const { qc, ticks } = setup();
    const release = holdLiveRefresh();
    await advance(LIVE_REFRESH_MS);
    expect(ticks()).toBe(0);
    release();
    release();
    expect(liveRefreshBlocked(qc)).toBe(false);
    const again = holdLiveRefresh();
    expect(liveRefreshBlocked(qc)).toBe(true);
    again();
    await advance(LIVE_REFRESH_MS);
    expect(ticks()).toBe(1);
  });

  it('stops when unmounted (signed out)', async () => {
    const { ticks } = setup();
    unmount!();
    unmount = undefined;
    await advance(LIVE_REFRESH_MS * 2);
    setVisibility('visible');
    expect(ticks()).toBe(0);
  });
});

describe('refreshForNews', () => {
  it('refetches what shows tickets, starting over, and resolves once the board has landed', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let land = () => {};
    let calls = 0;
    const board = watchBoard(qc, () => (++calls === 1 ? Promise.resolve({ cards: [] }) : new Promise((r) => (land = () => r({ cards: [1] })))));
    await advance(0);
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    let done = false;
    void refreshForNews(qc).then(() => (done = true));
    expect(invalidate.mock.calls.map(([f]) => f?.queryKey)).toEqual([qk.board, qk.cardLists, qk.calendars, qk.cards, qk.activities]);
    for (const [, options] of invalidate.mock.calls) expect(options).toEqual({ cancelRefetch: true });
    await advance(1_000);
    expect(board.fetches()).toBe(2);
    expect(done).toBe(false);
    land();
    await advance(0);
    expect(done).toBe(true);
    board.stop();
  });

  it('mid-queue it resolves at once, and the board refetches when the queue is empty', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const board = watchBoard(qc);
    await advance(0);
    const move = pendingMove(qc);
    let done = false;
    void refreshForNews(qc).then(() => (done = true));
    await advance(0);
    expect(done).toBe(true);
    expect(board.fetches()).toBe(1);
    move.finish();
    await advance(0);
    flushBoardRefetch(qc, move.vars); // what the operation's onSettled does
    await advance(0);
    expect(board.fetches()).toBe(2);
    board.stop();
  });

  it('mid-drag it resolves at once without refetching', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const board = watchBoard(qc);
    await advance(0);
    setDragging(true);
    await refreshForNews(qc);
    await advance(0);
    expect(board.fetches()).toBe(1);
    board.stop();
    flushBoardRefetch(qc, undefined); // clears the wish it left for after the drop
  });
});

describe('a failed refresh', () => {
  it('doesn’t toast (the next tick tries again); other failed refetches still do', async () => {
    let fail = false;
    const observer = new QueryObserver(queryClient, {
      queryKey: qk.board,
      queryFn: async () => {
        if (fail) throw new Error('Server unreachable');
        return { cards: [] };
      },
    });
    const stop = observer.subscribe(() => {});
    await advance(0);
    fail = true;
    liveRefreshTick(queryClient);
    await advance(0);
    expect(observer.getCurrentResult().isError).toBe(true);
    expect(toast).not.toHaveBeenCalled();

    void queryClient.invalidateQueries({ queryKey: qk.board });
    await advance(0);
    expect(toast).toHaveBeenCalledTimes(1);
    stop();
    queryClient.clear();
  });
});

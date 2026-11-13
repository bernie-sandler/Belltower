// Live refresh: the board, and whatever else shows tickets, refetches in the background, so a
// ticket filed on the submit page, through the API or by someone else turns up without a reload.
// Plain polling (no SSE or websocket): every LIVE_REFRESH_MS while the tab is visible, and once as
// soon as it becomes visible again. A hidden tab keeps only the bell's own poll; when that hears of
// something new, the bell runs the same refresh before it plays its sound (refreshForNews), so the
// ticket lands on the board together with the chime.
//
// A refresh never runs mid-drag or while a change is on its way to the server (a create or move in
// the board-order queue, an edit, a checklist mark waiting to be saved): landing then, it could
// undo on screen what you just did. That tick is skipped and the next one catches up. A refresh
// that fails says nothing (a missed poll isn't worth a toast; the next one tries again) until
// FAILED_TICKS_TO_WARN ticks in a row have failed. Its requests carry PASSIVE_HEADER, so an open tab
// doesn't keep an idle session alive.

import { useQueryClient, type Query, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect } from 'react';
import { isDragging } from '../lib/dragging';
import { toast } from '../lib/toast';
import { BOARD_ORDER_KEY, wantBoardRefetch } from './board';
import { passively } from './client';
import { qk } from './keys';

export const LIVE_REFRESH_MS = 15_000;

/**
 * What shows tickets: the board, card lists (Archive, Trash, the link picker), the calendar, and
 * the open card with its activity. invalidateQueries refetches only the queries on screen, so a
 * refresh costs a request or two.
 */
const TICKET_KEYS: readonly QueryKey[] = [qk.board, qk.cardLists, qk.calendars, qk.cards, qk.activities];

let holds = 0;

/**
 * Keeps live refreshes off until the returned function is called (extra calls do nothing). For a
 * change that shows at once but is sent later, such as a checklist mark resting before its save.
 */
export function holdLiveRefresh(): () => void {
  holds++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds--;
  };
}

/** Whether a refetch now could undo something on screen: a drag, a change not saved yet, a hold. */
export function liveRefreshBlocked(qc: QueryClient): boolean {
  return isDragging() || holds > 0 || qc.isMutating() > 0;
}

/** Queries a refresh refetched: if that fails, the global error toast stays quiet. */
const quiet = new WeakSet<object>();

/** For the query cache's onError: whether this failure came from a refresh. */
export function isQuietRefetch(query: object): boolean {
  return quiet.has(query);
}

/** For the query cache's onSettled: the query's next fetch may be someone else's. */
export function endQuietRefetch(query: object): void {
  quiet.delete(query);
}

/**
 * Refetches the active queries under `keys`, as requests the app makes on its own (they don't keep
 * an idle session alive). Resolves, once they have landed, with the queries it started.
 */
function refetch(qc: QueryClient, keys: readonly QueryKey[], cancelRefetch: boolean): Promise<Query[]> {
  const started: Query[] = [];
  for (const queryKey of keys) {
    for (const query of qc.getQueryCache().findAll({ queryKey, type: 'active' })) {
      // One already on its way is someone else's (a refetch on focus, say): its failure still toasts.
      if (query.state.fetchStatus !== 'idle') continue;
      quiet.add(query);
      started.push(query);
    }
  }
  return passively(() => Promise.all(keys.map((queryKey) => qc.invalidateQueries({ queryKey }, { cancelRefetch })))).then(() => started);
}

/** After this many ticks in a row whose refetches failed, one toast says so. */
export const FAILED_TICKS_TO_WARN = 3;
export const NOT_ANSWERING_MESSAGE = 'The board can’t refresh: the server isn’t answering. It will catch up once it’s back.';
let failedTicks = 0;

function countTick(started: Query[]): void {
  if (!started.length) return;
  if (started.some((q) => q.state.status === 'error')) {
    if (++failedTicks === FAILED_TICKS_TO_WARN) toast(NOT_ANSWERING_MESSAGE, { kind: 'warning' });
  } else {
    failedTicks = 0;
  }
}

/**
 * For the bell, when something new arrives: refetches what shows tickets, and resolves when that
 * has landed (or failed). Where a refetch would get in the way, it resolves at once instead, and
 * the board refetches when the board-order queue is empty (or at the next tick).
 */
export function refreshForNews(qc: QueryClient): Promise<void> {
  if (liveRefreshBlocked(qc)) {
    if (isDragging() || qc.isMutating({ mutationKey: BOARD_ORDER_KEY }) > 0) wantBoardRefetch();
    return Promise.resolve();
  }
  // A fetch already on its way may have left before the news: start over.
  return refetch(qc, TICKET_KEYS, true).then(() => undefined);
}

/** One tick: the bell's list and what shows tickets, unless the tab is hidden or it'd get in the way. */
export function liveRefreshTick(qc: QueryClient): void {
  if (document.visibilityState !== 'visible' || liveRefreshBlocked(qc)) return;
  // Doesn't cut short a fetch already on its way (a refetch on focus, say).
  void refetch(qc, [qk.notifications, ...TICKET_KEYS], false).then(countTick);
}

/** Mounted once, in the signed-in app shell. The gates are checked on every tick. */
export function useLiveRefresh(): void {
  const qc = useQueryClient();
  useEffect(() => {
    failedTicks = 0;
    const tick = () => liveRefreshTick(qc);
    let timer = setInterval(tick, LIVE_REFRESH_MS);
    // Back on the tab: refresh at once, and count the next tick from now.
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      clearInterval(timer);
      timer = setInterval(tick, LIVE_REFRESH_MS);
      tick();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [qc]);
}

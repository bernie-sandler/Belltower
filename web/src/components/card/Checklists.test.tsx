import { defaultScheduler, notifyManager, QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { CardDetail, ChecklistItem, ChecklistItemState } from '@tt/shared';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MARK_SAVE_DELAY_MS, useChecklistActions } from '../../api/cardParts';
import { api } from '../../api/client';
import { qk } from '../../api/keys';
import { itemStateIn, withItemState } from '../../lib/checkState';
import { cardDetail, checklistItem } from '../../test/fixtures';
import { Checklists } from './Checklists';

const CARD_ID = 7;

/** Reads the card from the cache like the card view does, so optimistic marks show. */
function CardHarness() {
  const { data } = useQuery({
    queryKey: qk.card(CARD_ID),
    queryFn: () => api.get<CardDetail>(`/api/cards/${CARD_ID}`),
    staleTime: Infinity,
  });
  return data ? <Checklists card={data} readOnly={false} addRequest={0} /> : null;
}

/** A response that settles in microtasks only, so fake timers control when it lands. */
const reply = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, statusText: '', text: async () => JSON.stringify(body) }) as Response;

/**
 * A fake server for one card. `holdNext` keeps the next mark save or delete waiting for
 * `release()`; `failNext` answers the next mark save with a 500.
 */
function setup(items: ChecklistItem[] = [checklistItem(1, 'open', 'Order battery'), checklistItem(2, 'open', 'Swap battery')]) {
  const server = { card: cardDetail(items, { id: CARD_ID }) };
  const saves: { id: number; state: ChecklistItemState }[] = [];
  const control = { holdNext: false, failNext: false, release: () => {} };
  const gate = async () => {
    if (!control.holdNext) return;
    control.holdNext = false;
    await new Promise<void>((resolve) => (control.release = resolve));
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const card = server.card;
      const m = /^\/api\/checklist-items\/(\d+)$/.exec(url);
      const id = Number(m?.[1]);
      if (m && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { state?: ChecklistItemState; text?: string };
        if (body.text !== undefined) {
          const items = card.checklists[0]!.items.map((i) => (i.id === id ? { ...i, text: body.text! } : i));
          server.card = { ...card, checklists: [{ ...card.checklists[0]!, items }], version: card.version + 1 };
          return reply(server.card);
        }
        saves.push({ id, state: body.state! });
        await gate();
        if (control.failNext) {
          control.failNext = false;
          return reply({ error: 'boom', message: 'Boom' }, 500);
        }
        server.card = { ...withItemState(server.card, id, body.state!), version: server.card.version + 1 };
        return reply(server.card);
      }
      if (m && init?.method === 'DELETE') {
        await gate();
        const items = card.checklists[0]!.items.filter((i) => i.id !== id);
        server.card = { ...card, checklists: [{ ...card.checklists[0]!, items }], checklistTotal: items.length };
        return reply(server.card);
      }
      if (url === `/api/cards/${CARD_ID}`) return reply(server.card);
      return reply([]);
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(qk.card(CARD_ID), server.card);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <StrictMode>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </StrictMode>
  );
  return { saves, qc, server, control, wrapper };
}

function renderList(items?: ChecklistItem[]) {
  const s = setup(items);
  const view = render(<CardHarness />, { wrapper: s.wrapper });
  return { ...s, view };
}

const item = (text: string) => screen.getByRole('button', { name: new RegExp(`^${text}, `) });
/** The item's accessible name: its text, then its mark. */
const nameOf = (text: string) => item(text).getAttribute('aria-label');
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

async function click(text: string, times = 1) {
  for (let i = 0; i < times; i++) fireEvent.click(item(text));
  await wait(0);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  // Cache updates reach components in microtasks, not on a (now fake) timer.
  notifyManager.setScheduler(queueMicrotask);
});

afterEach(() => {
  notifyManager.setScheduler(defaultScheduler);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Checklists', () => {
  it('cycles an item on click and saves only where the clicks stop', async () => {
    const { saves } = renderList();
    expect(item('Order battery').getAttribute('title')).toBe('Not checked — click for Done');
    expect(nameOf('Order battery')).toBe('Order battery, not checked');

    await click('Order battery', 3);
    expect(screen.getByRole('button', { name: 'Order battery, unverified' }).getAttribute('title')).toBe(
      'Unverified — click for Not checked',
    );
    expect(item('Order battery').closest('li')?.className).toBe('checklist-item is-unverified');
    expect(screen.getByRole('status').textContent).toBe('Order battery: unverified');

    await wait(MARK_SAVE_DELAY_MS - 100);
    expect(saves).toEqual([]);
    await wait(100);
    expect(saves).toEqual([{ id: 1, state: 'unverified' }]);
    await wait(MARK_SAVE_DELAY_MS * 2);
    expect(saves).toHaveLength(1);
  });

  it('saves nothing when the clicks end where they started', async () => {
    const { saves } = renderList();
    await click('Order battery', 4);
    expect(nameOf('Order battery')).toBe('Order battery, not checked');
    await wait(MARK_SAVE_DELAY_MS * 2);
    expect(saves).toEqual([]);
  });

  it('shows done and failed in the progress bar, and counts both as answered', async () => {
    const { qc } = renderList();
    await click('Order battery', 2);
    await click('Swap battery', 1);
    const bar = screen.getByRole('progressbar', { name: 'Checklist progress' });
    expect(bar.getAttribute('aria-valuenow')).toBe('2');
    expect(bar.getAttribute('aria-valuetext')).toBe('2 of 2: 1 done, 1 failed');
    const card = qc.getQueryData<CardDetail>(qk.card(CARD_ID))!;
    expect([card.checklistDone, card.checklistFailed, card.checklistUnverified]).toEqual([2, 1, 0]);
    expect(document.querySelector('.checklist-progress.is-complete')).toBeNull();
  });

  it('shows no progress bar for a checklist without items', () => {
    renderList([]);
    expect(screen.getByRole('heading', { name: 'Checklist' })).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('keeps a waiting mark on screen when another item’s save comes back', async () => {
    const { saves, qc } = renderList();
    await click('Order battery');
    await wait(MARK_SAVE_DELAY_MS - 200);
    await click('Swap battery', 2);
    await wait(200);
    expect(saves).toEqual([{ id: 1, state: 'done' }]);
    // The first save's card (item 2 still open) has landed, yet item 2 keeps its new mark.
    expect(qc.getQueryData<CardDetail>(qk.card(CARD_ID))?.version).toBe(2);
    expect(nameOf('Swap battery')).toBe('Swap battery, failed');
    await wait(MARK_SAVE_DELAY_MS);
    expect(saves).toEqual([
      { id: 1, state: 'done' },
      { id: 2, state: 'failed' },
    ]);
    expect(nameOf('Swap battery')).toBe('Swap battery, failed');
  });

  it('saves the next mark after a failed save, even if it matches the unsaved one', async () => {
    const { saves, server, control } = renderList();
    control.holdNext = true;
    control.failNext = true;
    await click('Order battery'); // ✓, saved slowly…
    await wait(MARK_SAVE_DELAY_MS);
    await click('Order battery'); // ✗ while that save is out
    control.release(); // …and it fails: the card reloads with the item still open
    await wait(0);
    expect(nameOf('Order battery')).toBe('Order battery, not checked');

    await click('Order battery'); // ✓ again, the mark the failed save was for
    await wait(MARK_SAVE_DELAY_MS);
    expect(saves).toEqual([
      { id: 1, state: 'done' },
      { id: 1, state: 'done' },
    ]);
    expect(itemStateIn(server.card, 1)).toBe('done');
  });

  it('saves waiting marks at once when the card closes', async () => {
    const { saves, view } = renderList();
    await click('Order battery', 2);
    view.unmount();
    await wait(0);
    expect(saves).toEqual([{ id: 1, state: 'failed' }]);
    await wait(MARK_SAVE_DELAY_MS * 2);
    expect(saves).toHaveLength(1);
  });

  it('saves waiting marks at once when the page is hidden or closed', async () => {
    const { saves } = renderList();
    await click('Order battery');
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => void document.dispatchEvent(new Event('visibilitychange')));
    visibility.mockRestore();
    expect(saves).toEqual([{ id: 1, state: 'done' }]);

    await click('Swap battery');
    await act(async () => void window.dispatchEvent(new Event('pagehide')));
    expect(saves).toEqual([
      { id: 1, state: 'done' },
      { id: 2, state: 'done' },
    ]);
    await wait(MARK_SAVE_DELAY_MS * 2);
    expect(saves).toHaveLength(2);
  });
});

describe('useChecklistActions', () => {
  const [first, second] = [checklistItem(1, 'open', 'Order battery'), checklistItem(2, 'open', 'Swap battery')];

  it('drops a waiting mark when its item is deleted, or is gone when the card closes', async () => {
    const { saves, qc, wrapper, control } = setup();
    const { result, unmount } = renderHook(() => useChecklistActions(CARD_ID), { wrapper });
    act(() => void result.current.cycle(first));
    control.holdNext = true; // a slow delete: the item is still in the cache when the timer runs out
    act(() => result.current.deleteItem.mutate(1));
    await wait(MARK_SAVE_DELAY_MS * 2);
    control.release();
    await wait(0);
    expect(saves).toEqual([]);

    // Deleted elsewhere: the reloaded card no longer has it.
    act(() => void result.current.cycle(second));
    qc.setQueryData<CardDetail>(qk.card(CARD_ID), (c) => c && { ...c, checklists: [{ ...c.checklists[0]!, items: [] }] });
    unmount();
    await wait(MARK_SAVE_DELAY_MS * 2);
    expect(saves).toEqual([]);
  });

  it('keeps waiting marks over the card other checklist actions return', async () => {
    const { qc, wrapper } = setup();
    const { result } = renderHook(() => useChecklistActions(CARD_ID), { wrapper });
    act(() => void result.current.cycle(second));
    act(() => result.current.editItem.mutate({ id: 1, text: 'Order two batteries' }));
    await wait(0);
    const card = qc.getQueryData<CardDetail>(qk.card(CARD_ID))!;
    expect(card.checklists[0]!.items.map((i) => [i.text, i.state])).toEqual([
      ['Order two batteries', 'open'],
      ['Swap battery', 'done'],
    ]);
    expect(card.checklistDone).toBe(1);
  });
});

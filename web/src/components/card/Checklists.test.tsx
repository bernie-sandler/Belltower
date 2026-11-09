import { defaultScheduler, notifyManager, QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { CardDetail, ChecklistItemState } from '@tt/shared';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MARK_SAVE_DELAY_MS } from '../../api/cardParts';
import { qk } from '../../api/keys';
import { withItemState } from '../../lib/checkState';
import { cardDetail, checklistItem } from '../../test/fixtures';
import { Checklists } from './Checklists';

const CARD_ID = 7;

/** Reads the card from the cache like the card view does, so optimistic marks show. */
function CardHarness() {
  const { data } = useQuery({ queryKey: qk.card(CARD_ID), queryFn: () => new Promise<CardDetail>(() => {}), staleTime: Infinity });
  return data ? <Checklists card={data} readOnly={false} addRequest={0} /> : null;
}

/** A response that settles in microtasks only, so fake timers control when it lands. */
const reply = (body: unknown) => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body) }) as Response;

function setup() {
  let server = cardDetail([checklistItem(1, 'open', 'Order battery'), checklistItem(2, 'open', 'Swap battery')], { id: CARD_ID });
  const saves: { id: number; state: ChecklistItemState }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const m = /^\/api\/checklist-items\/(\d+)$/.exec(url);
      if (m && init?.method === 'PATCH') {
        const { state } = JSON.parse(String(init.body)) as { state: ChecklistItemState };
        saves.push({ id: Number(m[1]), state });
        server = { ...withItemState(server, Number(m[1]), state), version: server.version + 1 };
        return reply(server);
      }
      return reply([]);
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(qk.card(CARD_ID), server);
  const view = render(
    <StrictMode>
      <QueryClientProvider client={qc}>
        <CardHarness />
      </QueryClientProvider>
    </StrictMode>,
  );
  return { saves, view, qc };
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
    const { saves } = setup();
    expect(item('Order battery').getAttribute('title')).toBe('Not checked — click for Done');

    expect(nameOf('Order battery')).toBe('Order battery, not checked');

    await click('Order battery', 3);
    expect(screen.getByRole('button', { name: 'Order battery, unverified' }).getAttribute('title')).toBe(
      'Unverified — click for Not checked',
    );
    expect(item('Order battery').closest('li')?.className).toBe('checklist-item is-unverified');

    await wait(MARK_SAVE_DELAY_MS - 100);
    expect(saves).toEqual([]);
    await wait(100);
    expect(saves).toEqual([{ id: 1, state: 'unverified' }]);
    await wait(MARK_SAVE_DELAY_MS * 2);
    expect(saves).toHaveLength(1);
  });

  it('saves nothing when the clicks end where they started', async () => {
    const { saves } = setup();
    await click('Order battery', 4);
    expect(nameOf('Order battery')).toBe('Order battery, not checked');
    await wait(MARK_SAVE_DELAY_MS * 2);
    expect(saves).toEqual([]);
  });

  it('shows done and failed in the progress bar, and counts both as answered', async () => {
    const { qc } = setup();
    await click('Order battery', 2);
    await click('Swap battery', 1);
    const bar = screen.getByRole('progressbar', { name: 'Checklist progress' });
    expect(bar.getAttribute('aria-valuenow')).toBe('2');
    expect(bar.getAttribute('aria-valuetext')).toBe('2 of 2: 1 done, 1 failed');
    const card = qc.getQueryData<CardDetail>(qk.card(CARD_ID))!;
    expect([card.checklistDone, card.checklistFailed, card.checklistUnverified]).toEqual([2, 1, 0]);
    expect(document.querySelector('.checklist-progress.is-complete')).toBeNull();
  });

  it('keeps a waiting mark on screen when another item’s save comes back', async () => {
    const { saves, qc } = setup();
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

  it('saves waiting marks at once when the card closes', async () => {
    const { saves, view } = setup();
    await click('Order battery', 2);
    view.unmount();
    await wait(0);
    expect(saves).toEqual([{ id: 1, state: 'failed' }]);
    await wait(MARK_SAVE_DELAY_MS * 2);
    expect(saves).toHaveLength(1);
  });
});

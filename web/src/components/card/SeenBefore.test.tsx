import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CardDetail, SimilarTicket } from '@tt/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tile } from '../../test/fixtures';
import { SeenBefore } from './SeenBefore';

const card = { ...tile({ id: 7, title: 'Plex buffering again' }), updatedAt: '2026-11-08T10:00:00.000Z' } as unknown as CardDetail;

const hit = (over: Partial<SimilarTicket>): SimilarTicket => ({
  id: 3,
  ticketNo: '261020-1',
  title: 'Plex buffering on the TV',
  completedAt: '2026-10-21T15:00:00.000Z',
  archived: false,
  resolution: 'Fixed',
  note: 'Moved the TV to 5 GHz',
  parent: null,
  ...over,
});

function setup(similar: SimilarTicket[]) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = url.endsWith('/similar') ? similar : init?.method === 'POST' ? card : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <SeenBefore card={card} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('SeenBefore', () => {
  it('lists finished tickets with how they ended, and links one as related', async () => {
    const fetchMock = setup([hit({}), hit({ id: 4, title: 'Plex buffering upstairs', note: '', parent: { id: 9, ticketNo: '261001-2', title: 'New mesh Wi-Fi' } })]);
    expect(await screen.findByText('Plex buffering on the TV')).toBeTruthy();
    expect(screen.getByText('Moved the TV to 5 GHz')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Finished with work card/ }).textContent).toContain('New mesh Wi-Fi');

    fireEvent.click(screen.getByRole('button', { name: 'Link “Plex buffering on the TV” as related' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === '/api/cards/7/links')).toBe(true));
    const [, init] = fetchMock.mock.calls.find(([url]) => url === '/api/cards/7/links') as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ otherCardId: 3, direction: 'relates' });
  });

  it('folds away, and shows nothing when there’s nothing similar', async () => {
    setup([hit({})]);
    const toggle = await screen.findByRole('button', { name: /Seen this before/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    expect(screen.queryByText('Plex buffering on the TV')).toBeNull();
  });

  it('renders nothing without matches', async () => {
    const fetchMock = setup([]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /Seen this before/ })).toBeNull();
  });
});

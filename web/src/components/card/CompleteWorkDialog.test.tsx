import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { qk } from '../../api/keys';
import { board, tile } from '../../test/fixtures';
import { CompleteWorkDialog } from './CompleteWorkDialog';

const work = tile({ id: 100, title: 'Plex upgrade', kind: 'work', childCount: 2, childOpen: 2 });
const kidA = tile({ id: 101, title: 'Back up DB', parentId: 100 });
const kidB = tile({ id: 102, title: 'Test HDR', parentId: 100, blockedBy: 1 });

function setup(response: { status: number; body: unknown }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(qk.board, board([work, kidA, kidB]));
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <CompleteWorkDialog card={work} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { fetchMock, onClose };
}

afterEach(() => vi.unstubAllGlobals());

describe('CompleteWorkDialog', () => {
  it('lists the open tickets and flags the blocked one', () => {
    setup({ status: 200, body: {} });
    expect(screen.getByText(/has 2 open tickets/)).toBeTruthy();
    expect(screen.getByText('Back up DB')).toBeTruthy();
    expect(screen.getAllByText('Blocked').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Complete with 2 tickets/ })).toBeTruthy();
  });

  it('completes with the tickets and closes', async () => {
    const { fetchMock, onClose } = setup({
      status: 200,
      body: { card: { ...work, completedAt: '2026-10-27T15:00:00.000Z' }, orders: {}, completed: [101, 102, 100] },
    });
    fireEvent.click(screen.getByRole('button', { name: /Complete with 2 tickets/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/cards/100/complete');
    expect(JSON.parse(String(init.body))).toEqual({ includeChildren: true, resolution: { reason: 'Fixed', note: '' } });
  });

  it('shows what the server says is stuck and stops offering "with tickets"', async () => {
    const { onClose } = setup({
      status: 409,
      body: {
        error: 'blocked',
        message: 'still blocked',
        stuck: [{ id: 102, ticketNo: '261027-102', title: 'Test HDR', blockers: [{ id: 5, title: 'Order cable' }] }],
      },
    });
    const button = screen.getByRole('button', { name: /Complete with 2 tickets/ }) as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/261027-102 \(by “Order cable”\)/));
    expect(button.disabled).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('"Only this card" completes just the work card', async () => {
    const { fetchMock } = setup({ status: 200, body: { card: work, orders: {}, completed: [100] } });
    fireEvent.click(screen.getByRole('button', { name: 'Only this card' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ includeChildren: false, resolution: { reason: 'Fixed', note: '' } });
  });
});

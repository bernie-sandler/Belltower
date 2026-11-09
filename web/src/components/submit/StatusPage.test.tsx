import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PublicTicketStatus } from '@tt/shared';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatusPage } from './StatusPage';

const base: PublicTicketStatus = {
  ticketNo: '261028-3',
  title: 'Plex buffering',
  submittedAt: '2026-10-28T14:00:00.000Z',
  state: 'received',
  resolution: null,
  changedAt: '2026-10-28T14:00:00.000Z',
};

function setup(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/submit/status/12/abcdefghijklmnopqrstuv']}>
        <Routes>
          <Route path="/submit/status/:id/:sig" element={<StatusPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('StatusPage', () => {
  it('asks for the ticket the link names and shows where it is', async () => {
    const fetchMock = setup(200, { ...base, state: 'waiting' });
    expect(await screen.findByRole('heading', { name: 'Waiting on something' })).toBeTruthy();
    expect(screen.getByText('Plex buffering')).toBeTruthy();
    expect(screen.getByText('261028-3')).toBeTruthy();
    expect(screen.getByText('Waiting').closest('li')?.getAttribute('aria-current')).toBe('step');
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/api/public/status/12/abcdefghijklmnopqrstuv');
  });

  it('shows the resolution reason once done', async () => {
    setup(200, { ...base, state: 'done', resolution: 'Fixed' });
    expect(await screen.findByRole('heading', { name: 'Done' })).toBeTruthy();
    expect(screen.getByText('It was closed as “Fixed”.')).toBeTruthy();
  });

  it('says the page doesn’t exist for a bad link', async () => {
    setup(404, { error: 'not_found', message: 'This page doesn’t exist' });
    expect(await screen.findByRole('heading', { name: 'This page doesn’t exist' })).toBeTruthy();
  });
});

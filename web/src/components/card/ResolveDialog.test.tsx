import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CardDetail } from '@tt/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { qk } from '../../api/keys';
import { board, tile } from '../../test/fixtures';
import { ResolveDialog } from './ResolveDialog';

const card = tile({ id: 7, title: 'Fans are loud' });

function setup(mode: 'complete' | 'edit', detail: Partial<CardDetail> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(qk.board, board([card]));
  const full = { ...card, resolutionNote: '', ...detail } as CardDetail;
  qc.setQueryData(qk.card(7), full);
  const fetchMock = vi.fn(async (url: string) => {
    const body = url.endsWith('/complete') ? { card: { ...full, completedAt: '2026-10-28T12:00:00.000Z' }, orders: {}, completed: [7] } : full;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <ResolveDialog cardId={7} mode={mode} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { fetchMock, onClose };
}

afterEach(() => vi.unstubAllGlobals());

describe('ResolveDialog', () => {
  it('defaults to the first reason, and Enter in the note marks the card done', async () => {
    const { fetchMock, onClose } = setup('complete');
    expect(screen.getByRole('radio', { name: 'Fixed' }).getAttribute('aria-checked')).toBe('true');
    const note = screen.getByRole('textbox');
    fireEvent.change(note, { target: { value: 'Cleaned the filter' } });
    fireEvent.keyDown(note, { key: 'Enter' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/cards/7/complete');
    expect(JSON.parse(String(init.body))).toEqual({ includeChildren: false, resolution: { reason: 'Fixed', note: 'Cleaned the filter' } });
  });

  it('edits the recorded resolution of a done card', async () => {
    const { fetchMock, onClose } = setup('edit', { completedAt: '2026-10-28T12:00:00.000Z', resolution: 'Fixed', resolutionNote: 'old' });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('old');
    fireEvent.click(screen.getByRole('radio', { name: 'Won’t fix' }));
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const patch = fetchMock.mock.calls.find((c) => (c as unknown as [string, RequestInit])[1]?.method === 'PATCH') as unknown as [string, RequestInit];
    expect(JSON.parse(String(patch[1].body))).toMatchObject({ resolution: { reason: 'Won’t fix', note: 'old' } });
  });
});

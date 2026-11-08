import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ApiTokenInfo } from '@tt/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TokensSection } from './TokensSection';

const token = (over: Partial<ApiTokenInfo>): ApiTokenInfo => ({
  id: 1,
  name: 'Uptime Kuma',
  prefix: 'tt_abcd',
  canComplete: false,
  scope: 'full',
  createdAt: '2026-10-01T15:00:00.000Z',
  lastUsedAt: null,
  revokedAt: null,
  ...over,
});

function setup(existing: ApiTokenInfo[] = []) {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/tokens' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      return json({ token: 'tt_secretsecretsecretsecret', info: token({ id: 9, name: body.name, scope: body.scope, canComplete: body.canComplete }) }, 201);
    }
    if (url === '/api/tokens') return json(existing);
    return json({ general: { appUrl: 'http://tower.lan:8080' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TokensSection />
    </QueryClientProvider>,
  );
  const posted = () => {
    const call = fetchMock.mock.calls.find(([url, init]) => url === '/api/tokens' && init?.method === 'POST');
    return call ? JSON.parse(String(call[1]!.body)) : undefined;
  };
  return { posted };
}

afterEach(() => vi.unstubAllGlobals());

describe('TokensSection', () => {
  it('creates a full token that may complete tickets, with the Uptime Kuma example', async () => {
    const { posted } = setup();
    fireEvent.change(screen.getByLabelText('New token for'), { target: { value: 'Uptime Kuma' } });
    fireEvent.click(screen.getByLabelText(/Recoveries may mark the ticket done/));
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    await waitFor(() => expect(posted()).toEqual({ name: 'Uptime Kuma', scope: 'full', canComplete: true }));
    expect(await screen.findByText(/Uptime Kuma: Notification type/)).toBeTruthy();
  });

  it('creates a read-only token with dashboard examples, and never asks it to complete tickets', async () => {
    const { posted } = setup();
    fireEvent.click(screen.getByLabelText(/Recoveries may mark the ticket done/));
    fireEvent.click(screen.getByLabelText(/Only read ticket counts/));
    expect(screen.queryByLabelText(/Recoveries may mark the ticket done/)).toBeNull();
    fireEvent.change(screen.getByLabelText('New token for'), { target: { value: 'Homepage' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    await waitFor(() => expect(posted()).toEqual({ name: 'Homepage', scope: 'read', canComplete: false }));
    expect(await screen.findByText(/Homepage: add to a group/)).toBeTruthy();
    expect(screen.getByText(/type: customapi/).textContent).toContain('url: http://tower.lan:8080/api/v1/summary');
    expect(screen.getByText(/Authorization: !secret belltower_token/)).toBeTruthy();
    expect(screen.queryByText(/Uptime Kuma: Notification type/)).toBeNull();
  });

  it('marks read-only tokens in the list', async () => {
    setup([token({ id: 2, name: 'Homepage', scope: 'read' }), token({ id: 1, canComplete: true })]);
    expect(await screen.findByText(/read-only · never used/)).toBeTruthy();
    expect(screen.getByText(/can complete · never used/)).toBeTruthy();
  });
});

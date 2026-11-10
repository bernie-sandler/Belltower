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
  owner: null,
  ...over,
});

function setup(existing: ApiTokenInfo[] = [], opts: { mine?: boolean; me?: { id: number; role: 'admin' | 'member' } } = {}) {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/tokens' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      return json({ token: 'tt_secretsecretsecretsecret', info: token({ id: 9, name: body.name, scope: body.scope, canComplete: body.canComplete }) }, 201);
    }
    if (url === '/api/tokens') return json(existing);
    if (url === '/api/me' && opts.me) return json(opts.me);
    return json({ general: { appUrl: 'http://tower.lan:8080' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TokensSection mine={opts.mine} />
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
    expect(await screen.findByText(/Homepage: an environment variable/)).toBeTruthy();
    expect(screen.getByText(/^HOMEPAGE_VAR_BELLTOWER_TOKEN=tt_/)).toBeTruthy();
    const homepage = screen.getByText(/type: customapi/).textContent;
    expect(homepage).toContain('url: http://tower.lan:8080/api/v1/summary');
    expect(homepage).toContain('Authorization: Bearer {{HOMEPAGE_VAR_BELLTOWER_TOKEN}}');
    expect(screen.getByText(/Authorization: !secret belltower_token/)).toBeTruthy();
    expect(screen.queryByText(/Uptime Kuma: Notification type/)).toBeNull();
  });

  it('marks read-only tokens in the list', async () => {
    setup([token({ id: 2, name: 'Homepage', scope: 'read' }), token({ id: 1, canComplete: true })]);
    expect(await screen.findByText(/read-only · never used/)).toBeTruthy();
    expect(screen.getByText(/can complete · never used/)).toBeTruthy();
  });

  it('shows whose each token is, and when a deactivated owner has stopped it', async () => {
    const alice = { id: 2, username: 'alice', displayName: 'Alice', role: 'member' as const, disabled: false };
    setup([token({ id: 2, name: 'Homepage', owner: alice }), token({ id: 1, owner: { ...alice, id: 3, displayName: 'Sam', disabled: true } })], {
      me: { id: 1, role: 'admin' },
    });
    expect(await screen.findByText('Alice')).toBeTruthy();
    expect(screen.getByText(/deactivated: stopped/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Automation' })).toBeTruthy();
  });

  it('Your tokens lists only your own, without an owner column', async () => {
    const me = { id: 2, username: 'alice', displayName: 'Alice', role: 'admin' as const, disabled: false };
    setup([token({ id: 2, name: 'Mine', owner: me }), token({ id: 1, name: 'Someone else’s', owner: { ...me, id: 3, displayName: 'Sam' } })], {
      mine: true,
      me,
    });
    expect(await screen.findByText('Mine')).toBeTruthy();
    expect(screen.queryByText('Someone else’s')).toBeNull();
    expect(screen.queryByText('Alice')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Your tokens' })).toBeTruthy();
  });
});

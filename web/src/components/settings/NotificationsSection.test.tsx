import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { NotifyChannelInfo, SettingsResponse } from '@tt/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationsSection } from './NotificationsSection';

const EVENTS = { external: true, critical: true, digest: false, blocked: false };
const off: NotifyChannelInfo = { set: false, hint: null, secretSet: false, events: EVENTS, lastDelivery: null };

const settings = {
  discord: {
    webhookSet: true,
    webhookHint: 'https://discord.com/api/webhooks/1234…/abcd…',
    events: EVENTS,
    digestTime: '08:00',
    alertPriority: 'high',
    alertSeverity: 'blocker',
    lastDelivery: null,
  },
  notify: {
    alerts: { digestTime: '08:00', alertPriority: 'high', alertSeverity: 'blocker' },
    channels: {
      ntfy: { ...off, set: true, hint: 'https://ntfy.sh/…', secretSet: true },
      gotify: off,
      webhook: { ...off, lastDelivery: { at: '2026-10-10T15:00:00.000Z', ok: false, message: 'The webhook answered 404' } },
    },
  },
} as unknown as SettingsResponse;

function setup() {
  const fetchMock = vi.fn(
    async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(settings), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', fetchMock);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NotificationsSection s={settings} />
    </QueryClientProvider>,
  );
  const sentTo = (path: string) => {
    const call = fetchMock.mock.calls.find(([url]) => url === path) as unknown as [string, RequestInit] | undefined;
    return call ? JSON.parse(String(call[1].body)) : undefined;
  };
  return { fetchMock, sentTo };
}

const panel = (name: string) => screen.getByText(name, { selector: 'summary strong' }).closest('details')!;

afterEach(() => vi.unstubAllGlobals());

describe('NotificationsSection', () => {
  it('opens the channels that are set up, and says which aren’t', () => {
    setup();
    expect(panel('Discord').open).toBe(true);
    expect(panel('ntfy').open).toBe(true);
    expect(panel('Gotify').open).toBe(false);
    expect(within(panel('ntfy')).getByPlaceholderText('Saved (type to replace)')).toBeTruthy();
  });

  it('saves a channel with only what changed (null keeps the saved address and token)', async () => {
    const { sentTo } = setup();
    const ntfy = within(panel('ntfy'));
    fireEvent.click(ntfy.getByLabelText('Daily summary of overdue and due-today cards'));
    fireEvent.click(ntfy.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sentTo('/api/settings/notify/ntfy')).toEqual({ url: null, secret: null, events: { ...EVENTS, digest: true } }));
  });

  it('Discord saves no longer carry the shared alert levels', async () => {
    const { sentTo } = setup();
    const discord = within(panel('Discord'));
    fireEvent.click(discord.getByLabelText('A card gets blocked'));
    fireEvent.click(discord.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sentTo('/api/settings/discord')).toEqual({ webhookUrl: null, events: { ...EVENTS, blocked: true } }));
  });

  it('removes a channel’s address and secret together', async () => {
    const { sentTo } = setup();
    fireEvent.click(within(panel('ntfy')).getByRole('button', { name: 'Remove ntfy' }));
    await waitFor(() => expect(sentTo('/api/settings/notify/ntfy')).toMatchObject({ url: '', secret: '' }));
  });

  it('can remove just the token, keeping the address', async () => {
    const { sentTo } = setup();
    fireEvent.click(within(panel('ntfy')).getByRole('button', { name: 'Remove access token' }));
    await waitFor(() => expect(sentTo('/api/settings/notify/ntfy')).toEqual({ url: null, secret: '', events: EVENTS }));
    expect(within(panel('ntfy')).getByLabelText('Access token (optional)')).toBeTruthy();
  });

  it('shows a failed last delivery', () => {
    setup();
    expect(within(panel('Webhook')).getByText(/failed.*The webhook answered 404/)).toBeTruthy();
  });
});

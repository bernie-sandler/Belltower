// Account → Notifications: the event × channel matrix, the install's missing channels explained,
// the random ntfy topic, and what Save sends.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DEFAULT_NOTIFY_PREFS, NtfyTopic, type PersonalNotifySettings } from '@tt/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationPrefsSection, randomTopic } from './NotificationPrefsSection';

function setup(settings: Partial<PersonalNotifySettings> = {}) {
  const current: PersonalNotifySettings = {
    discordUserId: null,
    ntfyTopic: null,
    prefs: DEFAULT_NOTIFY_PREFS,
    install: { discord: true, ntfy: false },
    ...settings,
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') return json({ ...current, ...(JSON.parse(String(init.body)) as object) });
    return json(current);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <NotificationPrefsSection />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const saved = () => {
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    return call ? JSON.parse(String(call[1]!.body)) : undefined;
  };
  return { saved };
}

afterEach(() => vi.unstubAllGlobals());

describe('NotificationPrefsSection', () => {
  it('saves the matrix, the Discord ID and the topic', async () => {
    const { saved } = setup();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Discord: You’re @mentioned' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'In the app: Cards you watch' }));
    fireEvent.change(screen.getByLabelText('Your Discord user ID'), { target: { value: ' 123456789012345678 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(saved()).toEqual({
        discordUserId: '123456789012345678',
        ntfyTopic: null,
        prefs: { ...DEFAULT_NOTIFY_PREFS, mentioned: { inApp: true, discord: true, ntfy: false }, watching: { inApp: false, discord: false, ntfy: false } },
      }),
    );
  });

  it('explains a channel the install doesn’t have, and keeps its boxes off', async () => {
    setup();
    expect(await screen.findByText(/This install has no ntfy channel yet\./)).toBeTruthy();
    expect(screen.getByText(/an admin sets it up first under Settings → Notifications/)).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'ntfy: Assigned to you' }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Discord: Assigned to you' }) as HTMLInputElement).disabled).toBe(false);
  });

  it('fills in a random topic that ntfy accepts, and checks what’s typed', async () => {
    setup({ install: { discord: true, ntfy: true } });
    fireEvent.click(await screen.findByRole('button', { name: /Random topic/ }));
    const topic = screen.getByLabelText('Your ntfy topic') as HTMLInputElement;
    expect(topic.value).toMatch(/^belltower-[a-z2-7]{20}$/);
    expect(NtfyTopic.safeParse(topic.value).success).toBe(true);
    expect(randomTopic()).not.toBe(randomTopic());
    fireEvent.change(topic, { target: { value: 'has space' } });
    expect(screen.getByText(/Start it with belltower-/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('warns when a channel is ticked with nowhere to send it', async () => {
    setup({ install: { discord: true, ntfy: true } });
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Discord: Assigned to you' }));
    expect(screen.getByText(/Discord is ticked, but there’s no Discord user ID/)).toBeTruthy();
    expect(screen.queryByText(/ntfy is ticked/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Your Discord user ID'), { target: { value: '123456789012345678' } });
    expect(screen.queryByText(/Discord is ticked/)).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'ntfy: Cards you watch' }));
    expect(screen.getByText(/ntfy is ticked, but there’s no topic/)).toBeTruthy();
  });

  it('only offers a test once something is saved', async () => {
    setup({ ntfyTopic: 'belltower-abc', install: { discord: true, ntfy: true } });
    const test = (await screen.findByRole('button', { name: /Send me a test/ })) as HTMLButtonElement;
    expect(test.disabled).toBe(false);
    fireEvent.change(screen.getByLabelText('Your ntfy topic'), { target: { value: 'belltower-abcd' } });
    expect(test.disabled).toBe(true);
  });
});

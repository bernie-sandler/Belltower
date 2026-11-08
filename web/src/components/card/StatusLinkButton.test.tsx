import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from '../../lib/clipboard';
import { StatusLinkButton } from './StatusLinkButton';

vi.mock('../../lib/clipboard', () => ({ copyText: vi.fn(async () => true) }));

function setup(link: { path: string; active: boolean }, appUrl = 'https://tower.example') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = url.endsWith('/status-link') ? link : { general: { appUrl } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <StatusLinkButton cardId={12} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return screen.getByRole('button', { name: 'Status link' }) as HTMLButtonElement;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(copyText).mockClear();
});

describe('StatusLinkButton', () => {
  it('loads the link with the card, so the click copies straight away', async () => {
    const button = setup({ path: '/submit/status/12/abcdefghijklmnopqrstuv', active: true });
    expect(button.disabled).toBe(true);
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    expect(copyText).toHaveBeenCalledWith('https://tower.example/submit/status/12/abcdefghijklmnopqrstuv');
  });

  it('copies nothing while the submit page is off', async () => {
    const button = setup({ path: '/submit/status/12/abcdefghijklmnopqrstuv', active: false });
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    expect(copyText).not.toHaveBeenCalled();
  });
});

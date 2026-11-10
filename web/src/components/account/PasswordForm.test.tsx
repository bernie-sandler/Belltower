import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MeResponse } from '@tt/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PasswordForm } from './PasswordForm';

const ME: MeResponse = {
  id: 2,
  username: 'sam',
  displayName: 'Sam',
  role: 'member',
  disabled: false,
  isOwner: false,
  email: null,
  hasPassword: true,
  createdAt: '2026-10-01T15:00:00.000Z',
  disabledAt: null,
  passwordManagedByEnv: false,
  ssoLinked: false,
};

function setup(me: Partial<MeResponse> = {}, reply: { status: number; body?: unknown } = { status: 204 }) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    reply.status === 204
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', fetchMock);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PasswordForm me={{ ...ME, ...me }} />
    </QueryClientProvider>,
  );
  const posted = () => {
    const call = fetchMock.mock.calls.find(([url, init]) => url === '/api/auth/password' && init?.method === 'POST');
    return call ? JSON.parse(String(call[1]!.body)) : undefined;
  };
  return { posted };
}

function fill(current: string, next: string, confirm = next) {
  fireEvent.change(screen.getByLabelText('Current password'), { target: { value: current } });
  fireEvent.change(screen.getByLabelText(/^New password/), { target: { value: next } });
  fireEvent.change(screen.getByLabelText(/^Confirm new password/), { target: { value: confirm } });
}

afterEach(() => vi.unstubAllGlobals());

describe('PasswordForm', () => {
  it('changes the password with the current one, then clears the form', async () => {
    const { posted } = setup();
    const button = screen.getByRole('button', { name: 'Change password' }) as HTMLButtonElement;
    fill('old password', 'a new password 1', 'a new password 2');
    expect(screen.getByText(/Passwords don.t match/)).toBeTruthy();
    expect(button.disabled).toBe(true);
    fill('old password', 'a new password 1');
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(posted()).toEqual({ currentPassword: 'old password', newPassword: 'a new password 1' }));
    await waitFor(() => expect((screen.getByLabelText('Current password') as HTMLInputElement).value).toBe(''));
  });

  it('says so when the current password is wrong, and clears only that field', async () => {
    setup({}, { status: 401, body: { error: 'invalid_password', message: 'Incorrect password' } });
    fill('wrong password', 'a new password 1');
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('The current password is incorrect.')).toBeTruthy();
    expect((screen.getByLabelText('Current password') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/^Confirm new password/) as HTMLInputElement).value).toBe('a new password 1');
  });

  it('is locked when APP_PASSWORD sets the owner’s password', () => {
    const { posted } = setup({ isOwner: true, passwordManagedByEnv: true });
    expect(screen.getByText(/so it can.t be changed here/)).toBeTruthy();
    expect(screen.getByLabelText('Current password').closest('fieldset')!.disabled).toBe(true); // the whole form
    expect((screen.getByRole('button', { name: 'Change password' }) as HTMLButtonElement).disabled).toBe(true);
    expect(posted()).toBeUndefined();
  });

  it('has nothing to change for someone who signs in only with single sign-on', () => {
    setup({ hasPassword: false });
    expect(screen.getByText(/single sign-on/)).toBeTruthy();
    expect(screen.queryByLabelText('Current password')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change password' })).toBeNull();
  });
});

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AuthStatus } from '@tt/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginPage } from './LoginPage';

function setup(sso: AuthStatus['sso'], url = '/login', passwordLogin: AuthStatus['passwordLogin'] = 'shown', loginReply?: unknown) {
  const status: AuthStatus = { authenticated: false, setupRequired: false, passwordManagedByEnv: false, sso, passwordLogin };
  const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/auth/login') && loginReply) return json(loginReply, 403);
      return json(status);
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <LoginPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('login page single sign-on', () => {
  it('offers "Sign in with …" as a plain link to the server when it is set up', async () => {
    setup({ label: 'Authentik' });
    const link = await screen.findByRole('link', { name: /Sign in with Authentik/ });
    expect(link.getAttribute('href')).toBe('/api/auth/oidc/start');
    // Shown: the password form is still there.
    expect(screen.getByRole('button', { name: 'Log in' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in with a password' })).toBeNull();
  });

  it('shows nothing extra without single sign-on', async () => {
    setup(null);
    expect(await screen.findByRole('button', { name: 'Log in' })).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('explains why the provider sent someone back', async () => {
    setup({ label: 'Authelia' }, '/login?sso_error=group');
    expect((await screen.findByRole('alert')).textContent).toMatch(/isn’t in the group allowed/);
  });

  it('ignores an unknown code', async () => {
    setup(null, '/login?sso_error=<script>');
    expect(await screen.findByRole('button', { name: 'Log in' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('login page password sign-in modes', () => {
  it('hidden: a link opens the form', async () => {
    setup({ label: 'Authentik' }, '/login', 'hidden');
    const open = await screen.findByRole('button', { name: 'Sign in with a password' });
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(screen.queryByText('or log in with your password')).toBeNull();
    fireEvent.click(open);
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Log in' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in with a password' })).toBeNull();
  });

  it('hidden: opens by itself after a single sign-on error', async () => {
    setup({ label: 'Authentik' }, '/login?sso_error=idp', 'hidden');
    expect((await screen.findByRole('alert')).textContent).toMatch(/log in with your password/);
    expect(screen.getByLabelText('Password')).toBeTruthy();
  });

  it('hidden: an unknown sso_error code doesn’t open the form', async () => {
    setup({ label: 'Authentik' }, '/login?sso_error=nonsense', 'hidden');
    expect(await screen.findByRole('button', { name: 'Sign in with a password' })).toBeTruthy();
    expect(screen.queryByLabelText('Password')).toBeNull();
  });

  it('hidden: /login?password opens the form', async () => {
    setup({ label: 'Authentik' }, '/login?password', 'hidden');
    await screen.findByRole('link', { name: /Sign in with Authentik/ });
    expect(screen.getByLabelText('Password')).toBeTruthy();
  });

  it('off: only the button, and error texts don’t point to a password', async () => {
    setup({ label: 'Authentik' }, '/login?sso_error=idp', 'off');
    await screen.findByRole('link', { name: /Sign in with Authentik/ });
    expect(screen.queryByRole('button', { name: 'Sign in with a password' })).toBeNull();
    expect(screen.queryByLabelText('Password')).toBeNull();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/ask your admin/);
    expect(alert.textContent).not.toMatch(/password/);
  });

  it('off: /login?password still shows the form, and a refusal says why', async () => {
    setup({ label: 'Authentik' }, '/login?password', 'off', { error: 'password_login_off', message: 'off' });
    await screen.findByRole('link', { name: /Sign in with Authentik/ });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'sam' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Password sign-in is turned off.*Sign in with Authentik/);
  });

  it('ignores the setting while single sign-on is off', async () => {
    setup(null, '/login', 'off');
    expect(await screen.findByRole('button', { name: 'Log in' })).toBeTruthy();
  });
});

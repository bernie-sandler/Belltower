import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AuthStatus } from '@tt/shared';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginPage } from './LoginPage';

function setup(sso: AuthStatus['sso'], url = '/login') {
  const status: AuthStatus = { authenticated: false, setupRequired: false, passwordManagedByEnv: false, sso };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(status), { status: 200, headers: { 'content-type': 'application/json' } })),
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
    // The password form is still there.
    expect(screen.getByRole('button', { name: 'Log in' })).toBeTruthy();
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

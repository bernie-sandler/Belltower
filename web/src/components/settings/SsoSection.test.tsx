import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { OidcSettingsInfo } from '@tt/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SsoSection } from './SsoSection';

const info: OidcSettingsInfo = {
  enabled: true,
  preset: 'authentik',
  buttonLabel: '',
  issuer: 'https://auth.example.com/application/o/belltower/',
  clientId: 'belltower',
  secretSet: true,
  secretFromEnv: false,
  scopes: '',
  usernameClaim: 'preferred_username',
  groupsClaim: 'groups',
  requiredGroup: '',
  autoCreate: false,
  linkByEmail: false,
  allowHttpIssuer: false,
  redirectUri: 'https://belltower.example.com/api/auth/oidc/callback',
  ready: true,
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(get: () => Response) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/settings/oidc' && init?.method === 'PUT') return json({ ...info, ...JSON.parse(String(init.body)) });
    if (url === '/api/settings/oidc/test') return json({ ok: true, issuer: info.issuer, message: `Found ${info.issuer}.` });
    return get();
  });
  vi.stubGlobal('fetch', fetchMock);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SsoSection />
    </QueryClientProvider>,
  );
  const sent = (method: string, path: string) => {
    const call = fetchMock.mock.calls.find(([url, init]) => url === path && init?.method === method);
    return call ? JSON.parse(String(call[1]!.body)) : undefined;
  };
  return { sent };
}

afterEach(() => vi.unstubAllGlobals());

describe('SsoSection', () => {
  it('shows the redirect URI to copy, and keeps the saved secret unless a new one is typed', async () => {
    const { sent } = setup(() => json(info));
    expect(await screen.findByText(info.redirectUri!)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Copy/ })).toBeTruthy();
    const secret = screen.getByLabelText(/^Client secret/) as HTMLInputElement;
    expect(secret.value).toBe('');
    expect(secret.placeholder).toMatch(/Saved/);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PUT', '/api/settings/oidc')).toMatchObject({ enabled: true, clientSecret: null, preset: 'authentik' }));
  });

  it('tests the connection with the form’s issuer', async () => {
    const { sent } = setup(() => json(info));
    fireEvent.click(await screen.findByRole('button', { name: /Test connection/ }));
    await waitFor(() => expect(sent('POST', '/api/settings/oidc/test')).toEqual({ preset: 'authentik', issuer: info.issuer, allowHttpIssuer: false }));
    expect(await screen.findByText(/^Found https:\/\/auth\.example\.com/)).toBeTruthy();
  });

  it('shows Authelia’s client snippet with PKCE and the redirect URI', async () => {
    setup(() => json(info));
    fireEvent.click(await screen.findByRole('radio', { name: 'Authelia' }));
    const snippet = screen.getByText(/identity_providers:/);
    expect(snippet.textContent).toContain(info.redirectUri);
    expect(snippet.textContent).toContain('require_pkce: true');
    expect(snippet.textContent).toContain("pkce_challenge_method: 'S256'");
    expect(snippet.textContent).toContain("token_endpoint_auth_method: 'client_secret_basic'");
    expect(snippet.textContent).toContain("scopes: ['openid', 'profile', 'email', 'groups']");
  });

  it('asks for the app’s address before there is a redirect URI', async () => {
    setup(() => json({ ...info, redirectUri: null, enabled: false, ready: false }));
    expect(await screen.findByText(/Set “This app’s address” under General first/)).toBeTruthy();
  });

  it('shows the demo’s notice instead of the form', async () => {
    setup(() => json({ error: 'demo_unavailable', message: 'Not available in the demo: single sign-on needs the server' }, 400));
    expect(await screen.findByText(/Not available in the demo/)).toBeTruthy();
    expect(screen.queryByLabelText(/^Issuer URL/)).toBeNull();
  });
});

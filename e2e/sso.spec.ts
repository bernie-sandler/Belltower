// Single sign-on (1.5): without a provider set up the login page is unchanged, and admins get the
// settings section. A real identity provider isn't needed here; server/test/oidc.test.ts drives a
// mock one through the whole flow.

import { expect, test, type Page } from '@playwright/test';
import { E2E_PASSWORD } from '../playwright.config';
import { Api, login } from './helpers';

/**
 * Turns single sign-on on (against an address nothing answers at: these tests never follow the
 * button) with a password sign-in mode. `register` gets the function that puts everything back
 * before anything changes, so a failure partway can't leave single sign-on on for later specs.
 */
async function ssoOn(page: Page, passwordLogin: 'shown' | 'hidden' | 'off', register: (restore: () => Promise<void>) => void): Promise<void> {
  await login(page);
  const api = new Api(page.request);
  const { general } = await api.call<{ general: { ticketFormat: string; appUrl: string; claudeModel: string } }>('GET', '/api/settings');
  const keep = { ticketFormat: general.ticketFormat, claudeModel: general.claudeModel };
  register(async () => {
    await login(page);
    await api.call('PUT', '/api/settings/oidc', { enabled: false, preset: 'authentik', issuer: '', clientId: '', clientSecret: '', passwordLogin: 'hidden' });
    await api.call('PUT', '/api/settings/general', { ...keep, appUrl: general.appUrl });
  });
  await api.call('PUT', '/api/settings/general', { ...keep, appUrl: 'http://127.0.0.1:9' });
  await api.call('PUT', '/api/settings/oidc', {
    enabled: true,
    preset: 'custom',
    issuer: 'http://127.0.0.1:9/idp',
    clientId: 'belltower-e2e',
    clientSecret: 'e2e-only-client-secret',
    allowHttpIssuer: true,
    passwordLogin,
  });
  await page.request.post('/api/auth/logout', { headers: { 'X-Requested-With': 'tower-tracker' } });
}

test('the login page shows no single sign-on until it is set up @mobile', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /log in/i })).toBeVisible();
  await expect(page.getByLabel('Username')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
  await expect(page.getByRole('link', { name: /sign in with/i })).toHaveCount(0);
  await expect(page.getByText('or log in with your password')).toHaveCount(0);
  expect((await (await page.request.get('/api/auth/status')).json()).sso).toBeNull();
});

test('admins get the Single sign-on section, with per-provider help', async ({ page }) => {
  await login(page);
  await page.goto('/settings');
  const heading = page.getByRole('heading', { name: 'Single sign-on' });
  await expect(heading).toBeVisible();
  const section = page.locator('section.settings-block', { has: heading });
  await expect(section.getByLabel('Turn on single sign-on')).not.toBeChecked();
  await expect(section.getByRole('radio', { name: 'Authentik' })).toHaveAttribute('aria-checked', 'true');
  await expect(section.getByText(/OpenID Configuration Issuer/)).toBeVisible();
  // No app address on this install yet, so there's no redirect URI to register.
  await expect(section.getByText(/Set “This app’s address” under General first/)).toBeVisible();

  await section.getByRole('radio', { name: 'Authelia' }).click();
  await expect(section.locator('pre')).toContainText('require_pkce: true');
  await section.getByRole('radio', { name: 'Custom' }).click();
  await expect(section.getByLabel(/^Username claim/)).toHaveValue('preferred_username');
  await expect(section.getByRole('button', { name: /Test connection/ })).toBeDisabled();
});

test.describe('password sign-in while single sign-on is on', () => {
  let restore: (() => Promise<void>) | null = null;
  test.afterEach(async () => {
    await restore?.();
    restore = null;
  });

  test('hidden: a link opens the password form @mobile', async ({ page }) => {
    await ssoOn(page, 'hidden', (r) => (restore = r));
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Sign in with single sign-on' })).toBeVisible();
    await expect(page.getByLabel('Password')).toHaveCount(0);
    await page.getByRole('button', { name: 'Sign in with a password' }).click();
    await page.getByLabel('Password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByRole('heading', { name: /log in/i })).toHaveCount(0);
  });

  test('off: only the button, and the owner still signs in at /login?password', async ({ page }) => {
    await ssoOn(page, 'off', (r) => (restore = r));
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Sign in with single sign-on' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in with a password' })).toHaveCount(0);
    await expect(page.getByLabel('Password')).toHaveCount(0);

    await page.goto('/login?password');
    await page.getByLabel('Password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByRole('heading', { name: /log in/i })).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);
  });
});

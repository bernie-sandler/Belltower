// Single sign-on (1.5): without a provider set up the login page is unchanged, and admins get the
// settings section. A real identity provider isn't needed here; server/test/oidc.test.ts drives a
// mock one through the whole flow.

import { expect, test } from '@playwright/test';
import { login } from './helpers';

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

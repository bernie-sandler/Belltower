// People (1.5): signing in by username, the owner's old saved name, and what a member sees.

import { expect, test, type Page } from '@playwright/test';
import { E2E_PASSWORD } from '../playwright.config';
import { Api } from './helpers';

const HEADERS = { 'X-Requested-With': 'tower-tracker' };

async function signIn(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /log in/i })).toBeVisible();
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /log in/i }).click();
  await expect(page.getByRole('link', { name: 'Board' })).toBeVisible();
}

async function openMenu(page: Page) {
  await page.getByRole('button', { name: 'Main menu' }).click();
  return page.getByRole('menu', { name: 'Main menu' });
}

test('signs in as admin with the username, and the Account page shows it @mobile', async ({ page }) => {
  await signIn(page, 'admin', E2E_PASSWORD);
  const menu = await openMenu(page);
  await expect(menu.getByRole('menuitem', { name: 'Backup & restore' })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Account' }).click();
  await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();
  await expect(page.getByText('Signed in as')).toContainText('admin (the owner)');
  await expect(page.getByLabel('Display name')).toHaveValue('Admin');
});

test('signs in with tower-tracker, the name password managers saved before 1.5', async ({ page }) => {
  await signIn(page, 'tower-tracker', E2E_PASSWORD);
  const me = await page.request.get('/api/me');
  expect((await me.json()).username).toBe('admin');
});

test('remembers the last username on this device', async ({ page }) => {
  await signIn(page, 'Admin', E2E_PASSWORD);
  const menu = await openMenu(page);
  await menu.getByRole('menuitem', { name: 'Log out' }).click();
  await expect(page.getByLabel('Username')).toHaveValue('Admin');
  await expect(page.getByLabel('Password')).toBeFocused();
});

test('a member added by an admin signs in and sees no admin-only settings', async ({ page, request }) => {
  // The admin adds someone through the API (the People screen comes later).
  const login = await request.post('/api/auth/login', { headers: HEADERS, data: { password: E2E_PASSWORD } });
  expect(login.status()).toBe(204);
  const username = `m${Math.random().toString(36).slice(2, 8)}`;
  await new Api(request).call('POST', '/api/users', { username, displayName: 'Morgan', role: 'member', password: 'member password 123' });

  await signIn(page, username, 'member password 123');
  const menu = await openMenu(page);
  await expect(menu.getByRole('menuitem', { name: 'Settings' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Account' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Backup & restore' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Automation' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();
  for (const admin of ['General', 'Submit page', 'Resolution reasons', 'Notifications']) {
    await expect(page.getByRole('heading', { name: admin, exact: true })).toHaveCount(0);
  }

  // Backups are for admins: the page sends a member back to the board, and the API refuses.
  await page.goto('/backup');
  await expect(page).toHaveURL(/\/$/);
  expect((await page.request.get('/api/backup/export.json')).status()).toBe(403);

  // Board work is for everyone.
  const card = await page.request.post('/api/cards', { headers: HEADERS, data: { title: `Member card ${username}` } });
  expect(card.status()).toBe(201);
});

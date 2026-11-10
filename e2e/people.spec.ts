// People (1.5, PR 2): an admin adds someone on the People screen, what that member sees, and who
// wrote each work-log note (only the author or an admin may change one).

import type { Page } from '@playwright/test';
import { E2E_PASSWORD } from '../playwright.config';
import { expect, test, unique } from './helpers';

const HEADERS = { 'X-Requested-With': 'tower-tracker' };
const MEMBER_PASSWORD = 'member password 123';

const newUsername = () => `p${Math.random().toString(36).slice(2, 8)}`;

async function openMenu(page: Page) {
  await page.getByRole('button', { name: 'Main menu' }).click();
  return page.getByRole('menu', { name: 'Main menu' });
}

async function signInThroughForm(page: Page, username: string, password: string) {
  await expect(page.getByRole('heading', { name: /log in/i })).toBeVisible();
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /log in/i }).click();
  await expect(page.getByRole('link', { name: 'Board' })).toBeVisible();
}

test('an admin adds a member on the People screen; the member signs in and sees no People @mobile', async ({ page, api: _signedIn }) => {
  const username = newUsername();
  const displayName = unique('Morgan'); // the desktop and iPhone runs share one database
  await page.goto('/settings');
  const people = page.locator('section.settings-block', { has: page.getByRole('heading', { name: 'People' }) });
  await expect(people.getByText('Owner')).toBeVisible();

  await people.getByRole('button', { name: 'Add person' }).click();
  const form = people.getByRole('form', { name: 'Add person' });
  await form.getByLabel('Username').fill(username);
  await form.getByLabel('Display name').fill(displayName);
  await form.getByLabel('Temporary password').fill(MEMBER_PASSWORD);
  await form.getByRole('button', { name: 'Add person' }).click();
  await expect(people.getByRole('status')).toContainText(`They sign in as ${username}`);
  const row = people.locator('.person-row', { hasText: displayName });
  await expect(row).toContainText('Member');
  await expect(row).toContainText('password set');

  // Sign out, then in as the new member.
  const menu = await openMenu(page);
  await menu.getByRole('menuitem', { name: 'Log out' }).click();
  await signInThroughForm(page, username, MEMBER_PASSWORD);

  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();
  for (const admin of ['People', 'Automation', 'General']) {
    await expect(page.getByRole('heading', { name: admin, exact: true })).toHaveCount(0);
  }
  expect((await page.request.get('/api/users')).status()).toBe(200); // the directory is for everyone…
  const add = await page.request.post('/api/users', { headers: HEADERS, data: { username: newUsername(), displayName: 'X', password: MEMBER_PASSWORD } });
  expect(add.status()).toBe(403); // …adding people isn't

  // Their own password and tokens are on the Account page.
  await page.goto('/account');
  await expect(page.getByRole('heading', { name: 'Your tokens' })).toBeVisible();
  await expect(page.getByLabel('Current password')).toBeVisible();
  await expect(page.getByText('Signed in as')).toContainText(username);
});

test('a work-log note shows who wrote it, and only its author or an admin can change it', async ({ page, api }) => {
  const card = await api.createCard({ title: unique('Fans loud') });
  await api.call('POST', `/api/cards/${card.id}/worklog`, { bodyMd: 'Admin checked the fans' });
  const username = newUsername();
  await api.call('POST', '/api/users', { username, displayName: 'Sam Ortiz', role: 'member', password: MEMBER_PASSWORD });

  // Switch the page's session to the member.
  await page.request.post('/api/auth/logout', { headers: HEADERS });
  const login = await page.request.post('/api/auth/login', { headers: HEADERS, data: { username, password: MEMBER_PASSWORD } });
  expect(login.status()).toBe(204);

  await page.goto(`/cards/${card.id}`);
  const adminNote = page.locator('.activity-item.is-worklog', { hasText: 'Admin checked the fans' });
  await expect(adminNote.locator('.activity-by')).toHaveText('Admin');
  await expect(adminNote.getByRole('button', { name: /Edit|Retract/ })).toHaveCount(0);

  await page.getByRole('textbox', { name: 'Log work' }).fill('Blew out the dust');
  await page.locator('.worklog-composer').getByRole('button', { name: 'Log work' }).click();
  const mine = page.locator('.activity-item.is-worklog', { hasText: 'Blew out the dust' });
  await expect(mine.locator('.activity-by')).toHaveText('Sam Ortiz');
  await expect(mine.getByRole('button', { name: /Edit/ })).toBeVisible();
  await expect(mine.getByRole('button', { name: /Retract/ })).toBeVisible();

  // The admin sees controls on everyone's notes.
  await page.request.post('/api/auth/logout', { headers: HEADERS });
  expect((await page.request.post('/api/auth/login', { headers: HEADERS, data: { password: E2E_PASSWORD } })).status()).toBe(204);
  await page.reload();
  await expect(mine.locator('.activity-by')).toHaveText('Sam Ortiz');
  await expect(mine.getByRole('button', { name: /Retract/ })).toBeVisible();
});

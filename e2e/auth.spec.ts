import { expect, test } from '@playwright/test';
import { E2E_PASSWORD } from '../playwright.config';

test('signs in with the password and out again @mobile', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /sign in|log in/i })).toBeVisible();

  await page.locator('input[type="password"]').fill('wrong password');
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await expect(page.getByRole('alert')).toContainText(/incorrect/i);

  await page.locator('input[type="password"]').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await expect(page.getByRole('link', { name: 'Board' })).toBeVisible();
  await expect(page.locator('section.column').first()).toBeVisible();

  await page.getByRole('button', { name: 'Main menu' }).click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  await expect(page.locator('input[type="password"]')).toBeVisible();
});

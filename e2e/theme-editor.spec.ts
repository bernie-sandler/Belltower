import { expect, login, test } from './helpers';

const cssVar = (page: import('@playwright/test').Page, name: string) =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

test('a preset and a typed color restyle the app, stay after a reload, and reset', async ({ page }) => {
  await login(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Customize colors…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Customize colors' });

  await dialog.getByRole('radio', { name: /^Ember/ }).click();
  await expect(dialog.getByRole('radio', { name: /^Ember/ })).toHaveAttribute('aria-checked', 'true');
  expect(await cssVar(page, '--bg')).toBe('#0e0d0b');

  const accent = dialog.getByRole('textbox', { name: 'Accent', exact: true });
  await accent.fill('rgb(200, 80, 160)');
  await accent.press('Enter');
  await expect(accent).toHaveValue('#c850a0');
  expect(await cssVar(page, '--accent')).toBe('#c850a0');
  await expect(dialog.getByRole('radio', { name: /^Ember/ })).toHaveAttribute('aria-checked', 'false');

  // Editing Light shows it for now; Done goes back to the saved choice (System, dark here).
  await dialog.getByRole('radio', { name: /^Light/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/);

  await page.reload();
  await expect(page.getByText('Custom colors in Dark.')).toBeVisible();
  expect(await cssVar(page, '--accent')).toBe('#c850a0');

  await page.getByRole('button', { name: 'Customize colors…' }).click();
  await dialog.getByRole('button', { name: 'Reset Dark' }).click();
  expect(await cssVar(page, '--accent')).toBe('#579dff');
  await expect(dialog.getByRole('radio', { name: /^Belltower/ })).toHaveAttribute('aria-checked', 'true');
  await dialog.getByRole('button', { name: 'Done' }).click();
  expect(await page.evaluate(() => localStorage.getItem('tt:custom-theme'))).toBeNull();
});

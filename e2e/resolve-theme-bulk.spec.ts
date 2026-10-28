import { column, dragTo, expect, test, tileByTitle, unique } from './helpers';

const HEADERS = { 'X-Requested-With': 'tower-tracker' };

test('Mark done asks how it was resolved; Enter accepts @mobile', async ({ page, api }) => {
  const card = await api.createCard({ title: unique('UPS beeping') });
  await page.goto(`/cards/${card.id}`);
  await page.getByRole('button', { name: 'Mark done' }).click();
  const dialog = page.getByRole('dialog', { name: 'Mark done' });
  await expect(dialog.getByRole('radio', { name: 'Fixed' })).toHaveAttribute('aria-checked', 'true');
  await dialog.getByRole('radio', { name: 'Won’t fix' }).click();
  await dialog.getByRole('textbox').fill('Replacing the whole UPS next month.');
  await dialog.getByRole('textbox').press('Enter');
  await expect(page.getByText('Marked done: Won’t fix')).toBeVisible();

  const section = page.locator('.card-section.resolution');
  await expect(section).toContainText('Won’t fix');
  await expect(section).toContainText('Replacing the whole UPS next month.');

  await page.goto('/');
  // Not the default reason, so the tile says so.
  await expect(tileByTitle(page, card.title).locator('.resolution-badge')).toHaveText(/Won’t fix/);
});

test('dragging into Done offers "Add resolution"', async ({ page, api }) => {
  const card = await api.createCard({ title: unique('Cert renewal'), columnId: await api.columnId('Backlog') });
  await page.goto('/');
  await dragTo(page, tileByTitle(page, card.title), column(page, 'Done'));
  // dnd-kit swallows clicks for a moment after a drop; a person never clicks that fast.
  await expect(page.getByText(`“${card.title}” is done.`)).toBeVisible();
  await page.waitForTimeout(100);
  await page.getByRole('button', { name: 'Add resolution' }).click();
  const dialog = page.getByRole('dialog', { name: 'Resolution' });
  await dialog.getByRole('textbox').fill('Renewed with certbot.');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Resolution saved')).toBeVisible();
  const saved = await api.call<{ resolution: string; resolutionNote: string }>('GET', `/api/cards/${card.id}`);
  expect(saved).toMatchObject({ resolution: 'Fixed', resolutionNote: 'Renewed with certbot.' });
});

test('the theme follows the system unless one is picked, per device', async ({ page, api }) => {
  void api; // signs in
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/settings');
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(await bg()).toBe('rgb(247, 248, 249)');

  const theme = page.getByRole('radiogroup', { name: 'Theme' });
  await theme.getByRole('radio', { name: 'Dark' }).click();
  expect(await bg()).toBe('rgb(29, 33, 37)');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'System' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/);
  expect(await bg()).toBe('rgb(247, 248, 249)');
});

test('"Describe several issues" previews the cards, then creates them', async ({ page, api }) => {
  const switchTitle = unique('Buy a 10GbE switch');
  const cards = [
    { ref: 'w', type: 'work', title: unique('Move to 10GbE'), priority: 'medium' },
    { ref: 'a', type: 'ticket', title: switchTitle, partOf: 'w', priority: 'low', checklist: ['Pick a model'] },
  ];
  // Stand-ins for Claude: drafting on, and a draft whose preview comes from the real importer.
  await page.route('**/api/ai/status', (route) => route.fulfill({ json: { enabled: true, model: 'claude-test' } }));
  await page.route('**/api/ai/draft-many', async (route) => {
    const preview = await page.request.post('/api/import/cards', { headers: HEADERS, data: { data: { cards }, dryRun: true } });
    await route.fulfill({ json: { cards, preview: await preview.json() } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Add ticket' }).click();
  await page.getByRole('menuitem', { name: /Describe several issues/ }).click();
  await page.getByRole('textbox', { name: 'Notes' }).fill('need a 10GbE switch, then re-cable');
  await page.getByRole('button', { name: 'Draft cards' }).click();

  const dialog = page.getByRole('dialog', { name: 'Review the cards' });
  await expect(dialog.getByText('Ready')).toBeVisible();
  await expect(dialog.getByText(switchTitle)).toBeVisible();
  await dialog.getByRole('button', { name: 'Create 2 cards' }).click();
  await expect(page.getByText('Created 2 cards')).toBeVisible();
  await expect(tileByTitle(page, switchTitle)).toBeVisible();
  expect((await api.board()).cards.some((c) => c.title === switchTitle)).toBe(true);
});

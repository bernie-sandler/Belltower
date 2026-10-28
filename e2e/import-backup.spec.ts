import { readFileSync } from 'node:fs';
import { expect, test, unique } from './helpers';

test('import: preview a work card with tickets and links, then import', async ({ page, api }) => {
  const work = unique('Upgrade UPS');
  const json = JSON.stringify({
    format: 'tower-tracker/cards@1',
    cards: [
      { type: 'work', ref: 'ups', title: work, tickets: [{ ref: 'order', title: unique('Order battery') }] },
      { title: unique('Swap battery'), partOf: 'ups', blockedBy: ['order'] },
    ],
  });
  await page.goto('/import');
  await page.getByLabel(/AI answer or card JSON/i).fill(json);
  await page.getByRole('button', { name: 'Preview' }).click();

  const preview = page.locator('.import-preview');
  await expect(preview.locator('.import-card')).toHaveCount(3);
  await expect(preview.getByText(/blocked by card 1\.1/)).toBeVisible();
  await page.getByRole('button', { name: /^Import 3 cards$/ }).click();
  await expect(page.getByRole('heading', { name: 'Imported 3 cards' })).toBeVisible();

  const created = (await api.board()).cards.find((c) => c.title === work);
  expect(created).toBeTruthy();
  const detail = await api.call<{ children: unknown[] }>('GET', `/api/cards/${created!.id}`);
  expect(detail.children).toHaveLength(2);
});

test('backup: download a JSON export and restore it', async ({ page, api }) => {
  const keep = await api.createCard({ title: unique('Survives restore') });
  await page.goto('/backup');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: /Download JSON/ }).click()]);
  const file = await download.path();
  const exported = JSON.parse(readFileSync(file, 'utf8')) as { format: string };
  expect(exported.format).toBe('tower-tracker-backup');

  // Changed after the export: the restore takes it away again.
  const later = await api.createCard({ title: unique('Made after the export') });

  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(page.getByText(/Backup from/)).toBeVisible();
  await page.locator('.restore-preview input.input').fill('RESTORE');
  await page.getByRole('button', { name: 'Restore this backup' }).click();
  await page.getByRole('button', { name: 'Replace all data' }).click();
  await page.waitForURL('/');

  const titles = (await api.board()).cards.map((c) => c.title);
  expect(titles).toContain(keep.title);
  expect(titles).not.toContain(later.title);
});

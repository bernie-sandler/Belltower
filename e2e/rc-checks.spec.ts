import { column, expect, test, tileByTitle, unique } from './helpers';

test('a card can be moved with the keyboard alone, and screen readers hear it', async ({ page, api }) => {
  const card = await api.createCard({ title: unique('Keyboard move'), columnId: await api.columnId('Backlog') });
  await page.goto('/');
  const tile = tileByTitle(page, card.title).getByRole('button', { name: new RegExp(card.title) }).first();
  await tile.focus();
  await page.keyboard.press('Space');
  // The live region says where the card is (the "Picked up" line is replaced straight away).
  await expect(page.getByRole('status').filter({ hasText: `“${card.title}” is over column Backlog.` })).toBeAttached();
  await page.keyboard.press('ArrowRight'); // Backlog → In Progress
  await expect(page.getByRole('status').filter({ hasText: 'is over column In Progress' })).toBeAttached();
  await page.keyboard.press('Space');
  await expect(page.getByText(/was dropped in column In Progress/)).toBeAttached();
  await expect(column(page, 'In Progress').getByText(card.title)).toBeVisible();
  await expect.poll(async () => (await api.board()).cards.find((c) => c.id === card.id)?.columnId).toBe(await api.columnId('In Progress'));
});

test('Done shows its most recent cards and the rest on request', async ({ page, api }) => {
  const done = await api.columnId('Done');
  const board = await api.board();
  const already = board.cards.filter((c) => c.columnId === done).length;
  // Enough finished cards that some are hidden, whatever earlier tests left in Done.
  const extra = Math.max(0, 55 - already);
  const titles: string[] = [];
  for (let i = 0; i < extra; i++) titles.push((await api.createCard({ title: unique(`Finished ${i}`), columnId: done })).title);
  const total = already + extra;

  await page.goto('/');
  const doneColumn = column(page, 'Done');
  await expect(doneColumn.locator('.tile')).toHaveCount(50);
  const more = doneColumn.getByRole('button', { name: `Show ${total - 50} older cards` });
  await expect(more).toBeVisible();
  await more.click();
  await expect(doneColumn.locator('.tile')).toHaveCount(total);
});

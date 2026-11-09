import { column, dragTo, expect, test, tileByTitle, unique } from './helpers';

test('quick-add a card and edit it in the card view @mobile', async ({ page, api }) => {
  const title = unique('Fan noise');
  await page.goto('/');
  await column(page, 'Triage').getByRole('button', { name: 'Add a card' }).click();
  await page.getByLabel('New card title').fill(title);
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Close composer' }).click();

  const tile = tileByTitle(page, title);
  await expect(tile).toBeVisible();
  // Ticket number "YYMMDD-N — Title".
  await expect(tile.locator('.ticket-no')).toHaveText(/^\d{6}-\d+$/);

  await tile.click();
  await expect(page).toHaveURL(/\/cards\/\d+$/);
  await page.locator('.card-title-btn').click();
  await page.locator('.card-title-input').fill(`${title} (edited)`);
  await page.keyboard.press('Enter');
  await expect(page.locator('.card-title')).toContainText('(edited)');

  const card = (await api.board()).cards.find((c) => c.title === `${title} (edited)`);
  expect(card).toBeTruthy();
});

test('Add ticket: blank ticket with a checklist', async ({ page, api }) => {
  const title = unique('Replace UPS battery');
  await page.goto('/');
  await page.getByRole('button', { name: 'Add ticket' }).click();
  await page.getByRole('menuitem', { name: /Blank ticket/ }).click();
  await page.getByPlaceholder('Short summary of the problem').fill(title);
  await page.getByRole('button', { name: 'Add item' }).click();
  await page.keyboard.type('Order battery');
  await page.getByRole('button', { name: 'Create ticket' }).click();
  await expect(page.getByText(/Ticket \d{6}-\d+ created/)).toBeVisible();

  const created = (await api.board()).cards.find((c) => c.title === title)!;
  const detail = await api.call<{ checklists: { items: { text: string }[] }[] }>('GET', `/api/cards/${created.id}`);
  expect(detail.checklists[0]!.items.map((i) => i.text)).toEqual(['Order battery']);
});

test('drag a card to another column', async ({ page, api }) => {
  const card = await api.createCard({ title: unique('Drag me') });
  await page.goto('/');
  await dragTo(page, tileByTitle(page, card.title), column(page, 'In Progress'));
  await expect(column(page, 'In Progress').locator('.tile-slot', { hasText: card.title })).toBeVisible();
  await expect.poll(async () => (await api.board()).cards.find((c) => c.id === card.id)?.columnId).toBe(await api.columnId('In Progress'));
});

test('a blocked card can’t be dragged into Done', async ({ page, api }) => {
  await api.call('PUT', '/api/board/blocked-column', { columnId: null }); // keep it where we put it
  const blocker = await api.createCard({ title: unique('Order part') });
  const blocked = await api.createCard({ title: unique('Install part') });
  await api.call('POST', `/api/cards/${blocked.id}/links`, { otherCardId: blocker.id, direction: 'blocked_by' });

  await page.goto('/');
  const tile = tileByTitle(page, blocked.title);
  await expect(tile.getByText('Blocked')).toBeVisible();
  await dragTo(page, tile, column(page, 'Done'));
  await expect(page.getByText(/is blocked by 1 open card/)).toBeVisible();
  const triage = await api.columnId('Triage');
  expect((await api.board()).cards.find((c) => c.id === blocked.id)?.columnId).toBe(triage);
});

test('filter and search find a card by ticket number', async ({ page, api }) => {
  const card = await api.createCard({ title: unique('Searchable card') });
  await page.goto('/');
  await page.getByLabel('Filter cards by text').fill(card.ticketNo);
  await expect(page.locator('.tile-slot')).toHaveCount(1);
  await expect(tileByTitle(page, card.title)).toBeVisible();

  await page.goto(`/search?q=${encodeURIComponent(card.ticketNo)}`);
  await expect(page.locator('.search-result-title')).toContainText(card.title);
});

test('link cards from the card view; the blocked one moves to Blocked/Waiting', async ({ page, api }) => {
  await api.call('PUT', '/api/board/blocked-column', { columnId: await api.columnId('Blocked/Waiting') });
  const blocker = await api.createCard({ title: unique('Order cable') });
  const card = await api.createCard({ title: unique('Rewire rack') });

  await page.goto(`/cards/${card.id}`);
  await page.getByRole('button', { name: 'Link card' }).click();
  await page.getByRole('radio', { name: 'Blocked by' }).click();
  await page.getByLabel('Search cards').fill(blocker.ticketNo);
  await page.locator('.pick-item', { hasText: blocker.title }).click();

  await expect(page.getByText(/Blocked, so moved to Blocked\/Waiting/)).toBeVisible();
  await expect(page.locator('.link-group', { hasText: 'Blocked by' })).toContainText(blocker.title);
  const blockedCol = await api.columnId('Blocked/Waiting');
  expect((await api.board()).cards.find((c) => c.id === card.id)?.columnId).toBe(blockedCol);
});

test('a checklist item cycles ✓ ✗ ~ and only the mark it stops on is recorded', async ({ page, api }) => {
  type Detail = { checklists: { id: number; items: { id: number; state: string }[] }[] };
  const card = await api.createCard({ title: unique('Check the UPS') });
  const listId = (await api.call<Detail>('POST', `/api/cards/${card.id}/checklists`, { title: 'Checks' })).checklists[0]!.id;
  const itemId = (await api.call<Detail>('POST', `/api/checklists/${listId}/items`, { text: 'Battery holds' })).checklists[0]!.items[0]!.id;

  await page.goto('/');
  await tileByTitle(page, card.title).click();
  const item = page.getByRole('button', { name: /^Battery holds, / });
  await expect(item).toHaveAccessibleName('Battery holds, not checked');
  await item.click({ clickCount: 3 }); // three quick clicks: ✓ then ✗ then ~
  await expect(item).toHaveAccessibleName('Battery holds, unverified');

  // Saved once the clicks stop, as a single history entry (not ✓, ✗ and ~).
  await expect
    .poll(async () => (await api.call<Detail>('GET', `/api/cards/${card.id}`)).checklists[0]!.items[0]!.state)
    .toBe('unverified');
  await expect
    .poll(async () => {
      const activity = await api.call<{ type: string; data: { itemId?: number; state?: string } | null }[]>('GET', `/api/cards/${card.id}/activity`);
      return activity.filter((e) => e.type.startsWith('checklist_item_') && e.data?.itemId === itemId).map((e) => [e.type, e.data?.state]);
    })
    .toEqual([['checklist_item_marked', 'unverified']]);

  await page.getByRole('button', { name: 'Close card' }).click();
  const badge = tileByTitle(page, card.title).locator('.checklist-badge');
  await expect(badge).toHaveClass(/\bis-unverified\b/);
  await expect(badge).toHaveAttribute('title', 'Checklist: 0/1, 1 unverified');
});

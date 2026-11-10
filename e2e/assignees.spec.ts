// Assignees (1.5): Unassigned → Take it → Mine, the tile badge, the card's picker, the board
// filter, and losing a race for the same card.

import { expect, test, tileByTitle, unique, type Api } from './helpers';

const queueRow = (page: import('@playwright/test').Page, title: string) => page.locator('.queue-row', { hasText: title });

async function me(api: Api) {
  return api.call<{ id: number; displayName: string }>('GET', '/api/me');
}

test('Unassigned → Take it → the card is in Mine, with my initials on the board @mobile', async ({ page, api }) => {
  const card = await api.createCard({ title: unique('Printer jammed'), priority: 'high' });
  const { displayName } = await me(api);

  await page.goto('/');
  await page.getByRole('link', { name: 'Unassigned' }).click();
  await expect(page).toHaveURL(/\/triage$/);
  await expect(page.getByRole('heading', { name: /Unassigned/ })).toBeVisible();
  const row = queueRow(page, card.title);
  await expect(row).toBeVisible();
  await expect(row.locator('.queue-column')).toHaveText('Triage');

  await row.getByRole('button', { name: /Take it/ }).click();
  await expect(page.getByText(`You took “${card.title}”`)).toBeVisible();
  await expect(row).toHaveCount(0);

  await page.getByRole('link', { name: 'Mine' }).click();
  await expect(page).toHaveURL(/\/mine$/);
  await expect(queueRow(page, card.title)).toBeVisible();
  await expect(queueRow(page, card.title).getByRole('button', { name: /Take it/ })).toHaveCount(0);

  // A click opens the card over the page.
  await queueRow(page, card.title).locator('.queue-open').click();
  await expect(page).toHaveURL(new RegExp(`/cards/${card.id}$`));
  await expect(page.getByLabel('Assignee')).toHaveValue(String((await me(api)).id));
  await page.goBack();

  await page.getByRole('link', { name: 'Board' }).click();
  const badge = tileByTitle(page, card.title).locator('.assignee-badge');
  await expect(badge).toHaveAttribute('title', `Assigned to ${displayName}`);
  await expect(badge).toContainText(`Assigned to ${displayName}`); // the screen-reader text
});

test('assign from the card, filter the board by assignee, and read it in the history', async ({ page, api }) => {
  const mine = await api.createCard({ title: unique('Swap UPS battery') });
  const other = await api.createCard({ title: unique('Label the cables') });
  const myId = (await me(api)).id;

  await page.goto(`/cards/${mine.id}`);
  await page.getByLabel('Assignee').selectOption(String(myId));
  await expect(page.getByLabel('Assignee')).toHaveValue(String(myId));
  await expect(page.getByRole('button', { name: 'Assign to me' })).toHaveCount(0);
  await expect(page.getByText('Took this')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.goto('/?assignee=me');
  await expect(tileByTitle(page, mine.title)).toBeVisible();
  await expect(tileByTitle(page, other.title)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Filters \(1\)/ })).toBeVisible();

  await page.getByRole('button', { name: /Filters/ }).click();
  const filters = page.getByRole('dialog', { name: 'Filters' });
  await filters.getByRole('button', { name: 'Me', exact: true }).click();
  await filters.getByRole('button', { name: 'Unassigned', exact: true }).click();
  await expect(page).toHaveURL(/assignee=none$/);
  await expect(tileByTitle(page, other.title)).toBeVisible();
  await expect(tileByTitle(page, mine.title)).toHaveCount(0);
});

test('Take it loses a race: someone else took it first', async ({ page, api }) => {
  const card = await api.createCard({ title: unique('Router reboot loop') });
  const username = `r${Math.random().toString(36).slice(2, 8)}`;
  const rival = await api.call<{ id: number }>('POST', '/api/users', { username, displayName: 'Robin Rival', role: 'member', password: 'rival password 123' });

  await page.goto('/triage');
  const row = queueRow(page, card.title);
  await expect(row).toBeVisible();
  // Meanwhile, on another device, the card goes to Robin.
  const current = await api.call<{ version: number }>('GET', `/api/cards/${card.id}`);
  await api.call('PATCH', `/api/cards/${card.id}`, { assigneeId: rival.id, expectedVersion: current.version });

  await row.getByRole('button', { name: /Take it/ }).click();
  await expect(page.getByText('Someone else took it: Robin Rival')).toBeVisible();
  await expect(row).toHaveCount(0);
  const after = await api.call<{ assigneeId: number | null }>('GET', `/api/cards/${card.id}`);
  expect(after.assigneeId).toBe(rival.id);
});

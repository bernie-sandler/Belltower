import { column, expect, test, tileByTitle, unique } from './helpers';

test('a work card groups its tickets and completes them together @mobile', async ({ page, api }) => {
  const backlog = await api.columnId('Backlog');
  const inProgress = await api.columnId('In Progress');
  const work = await api.createCard({ title: unique('Plex upgrade'), kind: 'work', columnId: backlog });
  const a = await api.createCard({ title: unique('Back up DB'), parentId: work.id, columnId: backlog });
  const b = await api.createCard({ title: unique('Test HDR'), parentId: work.id, columnId: inProgress });

  await page.goto('/');
  // Same column: indented under the work card. Other column: under a group header.
  await expect(column(page, 'Backlog').locator('.tile-row.is-nested', { hasText: a.title })).toBeVisible();
  await expect(column(page, 'In Progress').locator('.group-header', { hasText: work.title })).toBeVisible();
  await expect(tileByTitle(page, work.title).getByText('Work')).toBeVisible();

  await tileByTitle(page, work.title).click();
  await page.getByRole('button', { name: 'Mark done' }).click();
  await page.getByRole('button', { name: 'Complete with 2 tickets' }).click();
  await expect(page.getByText('Completed with 2 tickets')).toBeVisible();

  const done = await api.columnId('Done');
  const board = await api.board();
  for (const id of [work.id, a.id, b.id]) expect(board.cards.find((c) => c.id === id)?.columnId).toBe(done);
});

test('a collapsed group stays collapsed after a reload', async ({ page, api }) => {
  const backlog = await api.columnId('Backlog');
  const work = await api.createCard({ title: unique('NAS migration'), kind: 'work', columnId: backlog });
  const kid = await api.createCard({ title: unique('Copy shares'), parentId: work.id, columnId: backlog });

  await page.goto('/');
  const group = column(page, 'Backlog').locator('.tile-row', { hasText: work.title });
  await group.getByRole('button', { name: /1 ticket$/ }).click();
  await expect(tileByTitle(page, kid.title)).toHaveCount(0);
  await page.reload();
  await expect(group.getByRole('button', { name: /1 ticket hidden/ })).toBeVisible();
  await expect(tileByTitle(page, kid.title)).toHaveCount(0);
});

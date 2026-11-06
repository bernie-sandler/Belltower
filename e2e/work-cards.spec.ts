import type { Page } from '@playwright/test';
import { column, dragTo, expect, test, tileByTitle, unique, type Api } from './helpers';

type Ticket = Awaited<ReturnType<Api['createCard']>>;

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

test('dragging a folder header moves all its tickets to another column', async ({ page, api }) => {
  const backlog = await api.columnId('Backlog');
  const inProgress = await api.columnId('In Progress');
  const work = await api.createCard({ title: unique('Router swap'), kind: 'work', columnId: backlog });
  const a = await api.createCard({ title: unique('Order router'), parentId: work.id, columnId: inProgress });
  const b = await api.createCard({ title: unique('Flash firmware'), parentId: work.id, columnId: inProgress });

  await page.goto('/');
  const header = column(page, 'In Progress').locator('.group-header', { hasText: work.title }).locator('.group-toggle');
  await dragTo(page, header, column(page, 'Backlog'));

  // Both tickets follow the folder and end up under their work card.
  await expect(column(page, 'Backlog').locator('.tile-row.is-nested', { hasText: a.title })).toBeVisible();
  await expect(column(page, 'Backlog').locator('.tile-row.is-nested', { hasText: b.title })).toBeVisible();
  await expect(column(page, 'In Progress').locator('.group-header', { hasText: work.title })).toHaveCount(0);
  await expect
    .poll(async () => (await api.board()).cards.filter((c) => c.parentId === work.id).map((c) => c.columnId))
    .toEqual([backlog, backlog]);
});

/** A work card in Backlog, its tickets in another column, and the folder header there. */
async function folder(
  page: Page,
  api: Api,
  titles: string[],
  { columnName = 'In Progress' }: { columnName?: string } = {},
) {
  const columnId = await api.columnId(columnName);
  const backlog = await api.columnId('Backlog');
  const work = await api.createCard({ title: unique('Router swap'), kind: 'work', columnId: backlog });
  const tickets = [];
  for (const title of titles) tickets.push(await api.createCard({ title: unique(title), parentId: work.id, columnId }));
  await page.goto('/');
  const header = column(page, columnName).locator('.group-header', { hasText: work.title });
  await expect(header).toBeVisible();
  const whereTickets = async () => (await api.board()).cards.filter((c) => c.parentId === work.id).map((c) => c.columnId);
  return { columnId, backlog, work, tickets, header, handle: header.locator('.group-toggle'), whereTickets };
}

test('a folder move that fails partway moves nothing and says so', async ({ page, api }) => {
  const { columnId, work, tickets, handle, whereTickets } = await folder(page, api, ['Order router', 'Flash firmware', 'Swap cables']);
  const [first, trashed, last] = tickets as [Ticket, Ticket, Ticket];

  // Another device trashes the middle ticket, so this board is out of date.
  await api.call('DELETE', `/api/cards/${trashed.id}`);
  await dragTo(page, handle, column(page, 'Backlog'));

  await expect(page.getByText(`“${trashed.title}” is in the Trash. Nothing was moved.`)).toBeVisible();
  // The rest never left; the trashed one goes once the board has refreshed.
  await expect(tileByTitle(page, trashed.title)).toHaveCount(0);
  for (const t of [first, last]) await expect(column(page, 'In Progress').locator('.tile-slot', { hasText: t.title })).toBeVisible();
  await expect(column(page, 'In Progress').locator('.group-header', { hasText: work.title })).toBeVisible();
  expect(await whereTickets()).toEqual([columnId, columnId]);
});

test('a folder goes back when the server fails, and moves on the next try', async ({ page, api }) => {
  const { columnId, backlog, tickets, header, handle, whereTickets } = await folder(page, api, ['Order router', 'Flash firmware']);
  const inOrder = () => column(page, 'In Progress').locator('.tile-slot', { hasText: / / }).filter({ hasText: /Order router|Flash firmware/ });
  const expectBack = async () => {
    await expect(header).toBeVisible();
    for (const t of tickets) await expect(column(page, 'In Progress').locator('.tile-slot', { hasText: t.title })).toBeVisible();
    await expect(inOrder().last()).toContainText(tickets[1]!.title);
    expect(await whereTickets()).toEqual([columnId, columnId]);
  };

  await page.route('**/api/cards/move-many', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal', message: 'boom' }) }),
  );
  await dragTo(page, handle, column(page, 'Backlog'));
  await expect(page.getByText('Nothing was moved. The server hit an error. Try again.')).toBeVisible();
  await expectBack();

  // No answer at all: it can't say nothing moved, only that it couldn't confirm.
  await page.unroute('**/api/cards/move-many');
  await page.route('**/api/cards/move-many', (route) => route.abort());
  await dragTo(page, handle, column(page, 'Backlog'));
  await expect(page.getByText(/Couldn't confirm the move/)).toBeVisible();
  await expectBack();

  await page.unroute('**/api/cards/move-many');
  await dragTo(page, handle, column(page, 'Backlog'));
  await expect.poll(whereTickets).toEqual([backlog, backlog]);
  for (const t of tickets) await expect(column(page, 'Backlog').locator('.tile-row.is-nested', { hasText: t.title })).toBeVisible();
});

test('one blocked ticket keeps the whole folder out of Done', async ({ page, api }) => {
  // In Blocked/Waiting, because that's where a blocked ticket parks itself.
  const blocker = await api.createCard({ title: unique('Order part') });
  const { columnId, tickets, handle, whereTickets } = await folder(page, api, ['Fit part', 'Test part'], { columnName: 'Blocked/Waiting' });
  await api.call('POST', `/api/cards/${tickets[1]!.id}/links`, { otherCardId: blocker.id, direction: 'blocked_by' });
  await page.reload();
  await expect(handle).toBeVisible();

  await dragTo(page, handle, column(page, 'Done'));

  await expect(page.getByText(/is blocked by 1 open card/)).toBeVisible();
  expect(await whereTickets()).toEqual([columnId, columnId]);
});

test('a ticket blocked on another device keeps the folder out of Done too', async ({ page, api }) => {
  const blocker = await api.createCard({ title: unique('Order part') });
  const { work, tickets, handle, whereTickets } = await folder(page, api, ['Fit part', 'Test part']);
  const blocked = tickets[1]!;

  // Pinned to the board from before the link (mounting a tile refetches it, even mid-drag), so this
  // page can't know and only the server can refuse.
  const stale = await api.board();
  await page.route('**/api/board', (route) => route.fulfill({ json: stale }));
  await api.call('POST', `/api/cards/${blocked.id}/links`, { otherCardId: blocker.id, direction: 'blocked_by' });
  await dragTo(page, handle, column(page, 'Done'));

  await expect(page.getByText(new RegExp(`“${blocked.title}” can't be completed.*Nothing was moved\\.`))).toBeVisible();
  const done = await api.columnId('Done');
  expect(await whereTickets()).not.toContain(done);
  await expect(column(page, 'Done').locator('.group-header', { hasText: work.title })).toHaveCount(0);
  await expect(column(page, 'In Progress').locator('.tile-slot', { hasText: tickets[0]!.title })).toBeVisible();
});

test('a folder can be moved with the keyboard, and screen readers hear it', async ({ page, api }) => {
  const { backlog, work, tickets, handle, whereTickets } = await folder(page, api, ['Order router', 'Flash firmware']);

  await handle.focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('status').filter({ hasText: `folder “${work.title}” is over column In Progress.` })).toBeAttached();
  await page.keyboard.press('ArrowLeft'); // In Progress → Backlog
  await expect(page.getByRole('status').filter({ hasText: `folder “${work.title}” is over column Backlog.` })).toBeAttached();
  await page.keyboard.press('Space');

  await expect(page.getByText(`folder “${work.title}” was dropped in column Backlog.`)).toBeAttached();
  await expect.poll(whereTickets).toEqual([backlog, backlog]);
  // Picking it up with Space didn't also fold it.
  for (const t of tickets) await expect(column(page, 'Backlog').locator('.tile-row.is-nested', { hasText: t.title })).toBeVisible();
});

test('a folded folder brings its hidden tickets along', async ({ page, api }) => {
  const { backlog, work, tickets, handle, whereTickets } = await folder(page, api, ['Order router', 'Flash firmware']);

  await handle.click();
  await expect(handle).toHaveAttribute('aria-expanded', 'false');
  await expect(tileByTitle(page, tickets[0]!.title)).toHaveCount(0);
  await dragTo(page, handle, column(page, 'Backlog'));

  await expect.poll(whereTickets).toEqual([backlog, backlog]);
  await expect(column(page, 'In Progress').locator('.group-header', { hasText: work.title })).toHaveCount(0);
});

test('with a filter on, only the tickets you can see move', async ({ page, api }) => {
  const { columnId, backlog, tickets, handle } = await folder(page, api, ['Order router', 'Flash firmware']);
  const [shown, hidden] = tickets as [Ticket, Ticket];

  await page.getByLabel('Filter cards by text').fill(shown.title);
  await expect(tileByTitle(page, hidden.title)).toHaveCount(0);
  await dragTo(page, handle, column(page, 'Backlog'));

  const whereIs = async (id: number) => (await api.board()).cards.find((c) => c.id === id)?.columnId;
  await expect.poll(() => whereIs(shown.id)).toBe(backlog);
  expect(await whereIs(hidden.id)).toBe(columnId);
});

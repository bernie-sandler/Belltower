// Personal notifications (1.5, PR 5): an @mention rings the other person's bell (two browsers, the
// member's clock fast-forwarded past the 30-second poll), the Watch toggle, and the bell fitting a
// 375-pixel-wide phone next to the rest of the top bar.

import { expect, test, unique } from './helpers';

const HEADERS = { 'X-Requested-With': 'tower-tracker' };
const MEMBER_PASSWORD = 'member password 123';

test('mentioning a member in a note rings their bell; they open it from the bell', async ({ page, api, browser }) => {
  const username = `n${Math.random().toString(36).slice(2, 8)}`;
  const member = await api.call<{ id: number }>('POST', '/api/users', { username, displayName: unique('Riley'), role: 'member', password: MEMBER_PASSWORD });
  const card = await api.createCard({ title: unique('Router keeps rebooting') });
  const other = await browser.newContext();
  try {
    // The member, signed in in their own browser, with a clock the test can move.
    const m = await other.newPage();
    const login = await m.request.post('/api/auth/login', { headers: HEADERS, data: { username, password: MEMBER_PASSWORD } });
    expect(login.status()).toBe(204);
    await m.clock.install();
    await m.goto('/');
    const bell = m.getByRole('button', { name: /^Notifications/ });
    await expect(bell).toHaveAccessibleName('Notifications');

    // The admin mentions them, picking the name from the @ suggestions.
    await page.goto(`/cards/${card.id}`);
    const composer = page.getByRole('textbox', { name: 'Log work' });
    await composer.fill('Firmware updated; can you watch it tonight, @');
    await composer.pressSequentially(username.slice(0, 4));
    await expect(page.getByRole('option', { name: new RegExp(`@${username}`) })).toBeVisible();
    await composer.press('Enter');
    await expect(composer).toHaveValue(`Firmware updated; can you watch it tonight, @${username} `);
    await page.locator('.worklog-composer').getByRole('button', { name: 'Log work' }).click();
    await expect(page.locator('.activity-body .mention', { hasText: `@${username}` })).toBeVisible();

    // Past the 30-second poll, the member's bell has it.
    await m.clock.fastForward(31_000);
    await expect(bell).toHaveAccessibleName('Notifications, 1 unread');
    await expect(m.getByTestId('bell-count')).toHaveText('1');
    await bell.click();
    const item = m.getByRole('dialog', { name: 'Notifications' }).getByRole('button', { name: /mentioned you/ });
    await expect(item).toContainText(card.title);
    await item.click();
    await expect(m).toHaveURL(new RegExp(`/cards/${card.id}$`));
    await expect(bell).toHaveAccessibleName('Notifications');
    // Being mentioned on it means they watch it now.
    await expect(m.getByRole('button', { name: 'Unwatch' })).toBeVisible();
  } finally {
    await other.close();
    // People are never deleted; don't leave an active member behind in the shared database.
    await api.call('PATCH', `/api/users/${member.id}`, { disabled: true });
  }
});

test('Watch and Unwatch a card from its header @mobile', async ({ page, api }) => {
  // Made in the app by you: you watch it from the start.
  const card = await api.createCard({ title: unique('Pi-hole update') });
  await page.goto(`/cards/${card.id}`);
  await page.getByRole('button', { name: 'Unwatch' }).click();
  await expect(page.getByRole('button', { name: 'Watch', exact: true })).toBeVisible();
  expect((await api.call<{ watching: boolean }>('GET', `/api/cards/${card.id}`)).watching).toBe(false);
  await page.reload();
  await page.getByRole('button', { name: 'Watch', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unwatch' })).toBeVisible();
  expect((await api.call<{ watching: boolean }>('GET', `/api/cards/${card.id}`)).watching).toBe(true);
});

test('the bell fits a 375-pixel phone with the whole top bar, with room to spare, and its list opens on screen @mobile', async ({ page, api: _signedIn }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  const bell = page.getByRole('button', { name: /^Notifications/ });
  const nav = page.getByRole('navigation', { name: 'Main' });
  const add = page.getByRole('button', { name: 'Add ticket' });
  for (const path of ['/', '/mine', '/triage', '/search', '/calendar', '/templates']) {
    await page.goto(path);
    await expect(bell).toBeVisible();
    const links = nav.getByRole('link');
    await expect(links.first()).toBeVisible();
    // The current page still shows, by its highlight, and keeps its name for screen readers.
    await expect(nav.locator('a[aria-current="page"]')).toHaveCount(1);
    await expect(nav.locator('a[aria-current="page"]')).toHaveAccessibleName(/\w/);
    for (const el of [...(await links.all()), bell, add, page.getByRole('button', { name: 'Main menu' })]) {
      await expect(el, `${path}: ${await el.textContent()}`).toBeInViewport({ ratio: 1 });
    }
    // Headroom, so a wider system font (Linux, Android) can't push the nav off the screen: the nav
    // doesn't scroll, and at least 24 pixels are free between its last link and Add ticket.
    expect(await nav.evaluate((n) => n.scrollWidth - n.clientWidth), `${path}: nav overflow`).toBeLessThanOrEqual(0);
    const navEnd = Math.max(...(await Promise.all((await links.all()).map(async (l) => ((b) => (b ? b.x + b.width : 0))(await l.boundingBox())))));
    const addStart = (await add.boundingBox())!.x;
    expect(addStart - navEnd, `${path}: room between the nav and Add ticket`).toBeGreaterThanOrEqual(24);
  }
  await bell.click();
  const list = page.getByRole('dialog', { name: 'Notifications' });
  await expect(list).toBeInViewport({ ratio: 1 });
  await expect(list.getByRole('button', { name: 'Mark all read' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
});

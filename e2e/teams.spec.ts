// Settings → General → Teams, off by default: no Mine or Unassigned, no assignee controls, no Watch,
// no people's names in history; a ticket from the submit page still rings the admin's bell. The
// switch itself, and the top bar fitting a phone either way.
//
// The specs share one database and run one at a time (playwright.config.ts: one worker, files in
// turn). Each test here sets Teams and the submit page as it needs them and puts both back in a
// `finally`, so the specs around it see what they expect.

import type { Page } from '@playwright/test';
import { expect, test, tileByTitle, unique, type Api } from './helpers';

interface SubmitSettings {
  enabled: boolean;
  columnId: number | null;
  pageTitle: string;
  intro: string;
  key: string | null;
}

/** Teams off and the submit page on or off, for one test. `restore` puts both back as they were. */
async function solo(api: Api, submitPage: boolean) {
  const before = (await api.call<{ submit: SubmitSettings }>('GET', '/api/settings')).submit;
  const { columnId, pageTitle, intro } = before;
  const setSubmit = async (enabled: boolean) =>
    (await api.call<{ submit: SubmitSettings }>('PUT', '/api/settings/submit', { enabled, columnId, pageTitle, intro })).submit.key;
  const teamsBefore = await api.setTeams(false);
  const key = await setSubmit(submitPage);
  return {
    key,
    setSubmit,
    async restore() {
      await setSubmit(before.enabled);
      await api.setTeams(teamsBefore);
    },
  };
}

const navNames = (page: Page) =>
  page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link')
    .evaluateAll((els) => els.map((e) => e.textContent?.trim()));
const bellOf = (page: Page) => page.getByRole('button', { name: /^Notifications/ });

test('with Teams off there are no team pages, assignee controls, Watch or names in the history', async ({ page, api }) => {
  const s = await solo(api, false);
  const made: number[] = [];
  try {
    const me = await api.call<{ id: number }>('GET', '/api/me');
    // Assigning through the API still works; the assignment is kept, just not shown.
    const card = await api.createCard({ title: unique('Solo card'), assigneeId: me.id });
    made.push(card.id);
    await api.call('POST', `/api/cards/${card.id}/worklog`, { bodyMd: 'Checked the cable, @admin' });

    await page.goto('/');
    await expect(tileByTitle(page, card.title)).toBeVisible();
    expect(await navNames(page)).toEqual(['Board', 'Calendar', 'Search', 'Recurring']);
    await expect(bellOf(page)).toHaveCount(0);
    await expect(tileByTitle(page, card.title).locator('.assignee-badge')).toHaveCount(0);

    // The filter has no Assignee group, and a leftover ?assignee= in the address is ignored.
    await page.getByRole('button', { name: /Filters/ }).click();
    const filters = page.getByRole('dialog', { name: 'Filters' });
    await expect(filters.getByText('Labels', { exact: true })).toBeVisible();
    await expect(filters.getByText('Assignee', { exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.goto('/?assignee=none');
    await expect(tileByTitle(page, card.title)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Filters', exact: true })).toBeVisible();

    // Mine and Unassigned go to the board.
    for (const path of ['/mine', '/triage']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByRole('link', { name: 'Board' })).toBeVisible();
    }

    // The card: no assignee picker or Watch; the history names nobody, and @admin is plain text.
    await page.goto(`/cards/${card.id}`);
    const note = page.locator('.activity-item.is-worklog', { hasText: 'Checked the cable' });
    await expect(note).toBeVisible();
    await expect(note.locator('.activity-body')).toHaveText('Checked the cable, @admin');
    await expect(note.locator('.mention')).toHaveCount(0);
    await expect(page.locator('.activity-by')).toHaveCount(0);
    await expect(page.getByText('Took this')).toHaveCount(0);
    await expect(page.getByLabel('Assignee')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^(Watch|Unwatch)$/ })).toHaveCount(0);
    // @ offers nobody.
    const composer = page.getByRole('textbox', { name: 'Log work' });
    await composer.fill('Ask @adm');
    await expect(page.getByRole('option')).toHaveCount(0);
    await composer.fill('');

    // Account has no Notifications; Settings → Appearance has no sound for a bell that isn't there.
    await page.goto('/account');
    await expect(page.getByRole('heading', { name: 'Your tokens' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toHaveCount(0);
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Theme' })).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Sound for new notifications' })).toHaveCount(0);
  } finally {
    for (const id of made) await api.call('DELETE', `/api/cards/${id}`);
    await s.restore();
  }
});

test('with Teams off a ticket from the submit page still rings the admin’s bell', async ({ page, api, browser }) => {
  const s = await solo(api, true);
  let cardId: number | null = null;
  try {
    // Start from a quiet bell (earlier specs may have left submit-page tickets in it).
    await api.call('POST', '/api/notifications/read', { all: true });
    await page.clock.install();
    await page.goto('/');
    const bell = bellOf(page);
    await expect(bell).toHaveAccessibleName('Notifications');
    expect(await navNames(page)).toEqual(['Board', 'Calendar', 'Search', 'Recurring']);

    // Someone without an account files a ticket.
    const summary = unique('buffering');
    const visitor = await browser.newContext();
    try {
      const v = await visitor.newPage();
      await v.goto(`/submit/${s.key}`);
      await v.getByRole('radio', { name: /Plex/ }).click();
      await v.getByLabel('Title *').fill(summary);
      await v.getByLabel('What’s wrong? *').fill('Spins forever at 99%.');
      await v.getByLabel('Movie or TV show *').fill('Arrival');
      await v.getByLabel('Media type *').selectOption('Movie');
      await v.getByLabel('Device or app *').selectOption('Roku');
      await v.getByLabel('Your name').fill('Kim');
      await v.getByRole('button', { name: 'Send' }).click();
      await expect(v.getByRole('heading', { name: 'Thanks!' })).toBeVisible();
    } finally {
      await visitor.close();
    }

    // Past the 30-second poll, the bell has it; opening it opens the ticket and marks it read.
    await page.clock.fastForward(31_000);
    await expect(bell).toHaveAccessibleName('Notifications, 1 unread');
    await bell.click();
    const item = page.getByRole('dialog', { name: 'Notifications' }).getByRole('button', { name: /New ticket from submit page \(Kim\)/ });
    await expect(item).toContainText(`Plex – Arrival – ${summary}`);
    await item.click();
    await expect(page).toHaveURL(/\/cards\/\d+$/);
    cardId = Number(/\/cards\/(\d+)$/.exec(page.url())![1]);
    await expect(bell).toHaveAccessibleName('Notifications');

    // With the submit page off too, there's no bell.
    await s.setSubmit(false);
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Board' })).toBeVisible();
    await expect(bell).toHaveCount(0);
  } finally {
    if (cardId !== null) await api.call('DELETE', `/api/cards/${cardId}`);
    await s.restore();
  }
});

test('the Teams switch brings the team features back, and asks before hiding them from others', async ({ page, api }) => {
  const teamsBefore = await api.setTeams(false);
  // Someone else on the board, so turning Teams off asks first.
  const username = `t${Math.random().toString(36).slice(2, 8)}`;
  const other = await api.call<{ id: number }>('POST', '/api/users', { username, displayName: 'Taylor', role: 'member', password: 'member password 123' });
  try {
    await page.goto('/settings');
    const teams = page.getByRole('switch', { name: 'Teams' });
    await expect(teams).not.toBeChecked();
    await expect(page.getByText('Turn on Teams in General to assign cards to people')).toBeVisible();
    await teams.click();
    await expect(teams).toBeChecked();
    await expect(page.getByRole('link', { name: 'Mine' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Unassigned' })).toBeVisible();
    await expect(bellOf(page)).toBeVisible();
    await expect(page.getByText('Turn on Teams in General to assign cards to people')).toHaveCount(0);

    await teams.click();
    const dialog = page.getByRole('dialog', { name: 'Turn off Teams?' });
    await expect(dialog).toContainText(/\d+ other (person uses|people use) this board; their assignments and watches are kept but hidden\./);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(teams).toBeChecked();
    await teams.click();
    await page.getByRole('dialog', { name: 'Turn off Teams?' }).getByRole('button', { name: 'Turn off Teams' }).click();
    await expect(teams).not.toBeChecked();
    await expect(page.getByRole('link', { name: 'Mine' })).toHaveCount(0);
    expect((await api.call<{ teams: boolean }>('GET', '/api/config')).teams).toBe(false);
  } finally {
    // People are never deleted; don't leave an active member behind in the shared database.
    await api.call('PATCH', `/api/users/${other.id}`, { disabled: true });
    await api.setTeams(teamsBefore);
  }
});

test('the top bar fits with Teams off, with and without the bell, and on @mobile', async ({ page, api }) => {
  const s = await solo(api, false);
  try {
    const { width: deviceWidth, height } = page.viewportSize()!;
    const phone = deviceWidth < 768;
    const nav = page.getByRole('navigation', { name: 'Main' });
    const bell = bellOf(page);
    const add = page.getByRole('button', { name: 'Add ticket' });
    const menu = page.getByRole('button', { name: 'Main menu' });

    async function fits(expected: string[], withBell: boolean) {
      // At the device's own width, and on a phone also at 375 pixels (the narrowest we support).
      for (const width of phone ? [deviceWidth, 375] : [deviceWidth]) {
        await page.setViewportSize({ width, height });
        for (const path of ['/', '/search']) {
          await page.goto(path);
          await expect(nav.getByRole('link').first()).toBeVisible();
          expect(await navNames(page), `${width}px ${path}`).toEqual(expected);
          await expect(bell).toHaveCount(withBell ? 1 : 0);
          for (const el of [...(await nav.getByRole('link').all()), ...(withBell ? [bell] : []), add, menu]) {
            await expect(el, `${width}px ${path}: ${await el.getAttribute('aria-label') ?? await el.textContent()}`).toBeInViewport({ ratio: 1 });
          }
          expect(await nav.evaluate((n) => n.scrollWidth - n.clientWidth), `${width}px ${path}: nav overflow`).toBeLessThanOrEqual(0);
        }
      }
    }

    const solo4 = phone ? ['Board', 'Search'] : ['Board', 'Calendar', 'Search', 'Recurring'];
    await fits(solo4, false);
    await s.setSubmit(true); // the admin's bell comes back for submit-page tickets
    await fits(solo4, true);
    await api.setTeams(true);
    await fits(phone ? ['Board', 'Mine', 'Unassigned', 'Search'] : ['Board', 'Mine', 'Unassigned', 'Calendar', 'Search', 'Recurring'], true);
  } finally {
    await s.restore();
  }
});

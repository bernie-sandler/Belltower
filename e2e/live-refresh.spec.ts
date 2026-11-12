// Live refresh: with the board open, a ticket filed somewhere else turns up on it without a reload.
// The board refetches every 15 seconds while the tab is visible; the page's clock is moved past
// that tick but not past the bell's 30-second poll, so it's the live refresh that brings it in.
//
// The specs share one database and run one at a time (playwright.config.ts). This test turns the
// submit page on and puts its settings back in a `finally`, and deletes the ticket it filed.

import { column, expect, test, unique, visitorContext } from './helpers';

interface SubmitSettings {
  enabled: boolean;
  columnId: number | null;
  pageTitle: string;
  intro: string;
  key: string | null;
}

test('a ticket from the submit page shows up on the open board without a reload', async ({ page, api, browser }) => {
  const before = (await api.call<{ submit: SubmitSettings }>('GET', '/api/settings')).submit;
  const putSubmit = (enabled: boolean, columnId: number | null) =>
    api.call<{ submit: SubmitSettings }>('PUT', '/api/settings/submit', { enabled, columnId, pageTitle: before.pageTitle, intro: before.intro });
  // On, with tickets landing in Triage (columnId null).
  const { key } = (await putSubmit(true, null)).submit;
  const summary = unique('NAS fans loud');
  try {
    await page.clock.install();
    await page.goto('/');
    const triage = column(page, 'Triage');
    await expect(triage).toBeVisible();
    const tile = triage.locator('.tile-slot', { hasText: summary });

    // Someone without an account files a ticket in their own browser (with an address of its own,
    // so this doesn't use up the submit rate limit the other specs share).
    const visitor = await visitorContext(browser);
    try {
      const v = await visitor.newPage();
      await v.goto(`/submit/${key}`);
      await v.getByRole('radio', { name: /General/ }).click();
      await v.getByLabel('Title *').fill(summary);
      await v.getByLabel('What’s wrong? *').fill('Louder since the last update.');
      await v.getByLabel('Where does this apply? *').selectOption('Something else');
      await v.getByRole('button', { name: 'Send' }).click();
      await expect(v.getByRole('heading', { name: 'Thanks!' })).toBeVisible();
    } finally {
      await visitor.close();
    }

    // Not on the open board yet; past the 15-second refresh (and short of the bell's 30-second
    // poll) it is, with no reload.
    await expect(tile).toHaveCount(0);
    await page.clock.fastForward(16_000);
    await expect(tile).toBeVisible();
  } finally {
    const card = (await api.board()).cards.find((c) => c.title.includes(summary));
    if (card) await api.call('DELETE', `/api/cards/${card.id}`);
    await putSubmit(before.enabled, before.columnId);
  }
});

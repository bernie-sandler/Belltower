import { expect, test, unique } from './helpers';

test('someone without the password files a ticket through the submit page @mobile', async ({ page, api, browser }) => {
  const s = await api.call<{ submit: { key: string } }>('PUT', '/api/settings/submit', {
    enabled: true,
    columnId: null,
    pageTitle: 'Report a problem',
    intro: 'Tell us what’s wrong.',
  });
  const summary = unique('stutters');

  // A fresh browser with no session, sized like the page under test.
  const visitor = await browser.newContext({ viewport: page.viewportSize() ?? undefined, hasTouch: true });
  const v = await visitor.newPage();
  await v.goto(`/submit/${s.submit.key}`);
  await expect(v.getByRole('heading', { name: 'Report a problem' })).toBeVisible();
  await v.getByRole('radio', { name: /Plex/ }).click();
  await v.getByLabel('Title *').fill(summary);
  await v.getByLabel('What’s wrong? *').fill('Freezes for a second.');
  await v.getByLabel('Movie or TV show *').fill('Interstellar');
  await v.getByLabel('Media type *').selectOption('Movie');
  await v.getByLabel('Device or app *').selectOption('Roku');
  await v.getByLabel('Your name').fill('Sam');
  await v.getByRole('button', { name: 'Send' }).click();
  await expect(v.getByRole('heading', { name: 'Thanks!' })).toBeVisible();
  const ticketNo = (await v.locator('.submit-done .ticket-no').textContent())!;

  // The thank-you screen's status link opens the ticket's status page, still signed out.
  await v.locator('.submit-status-link a').click();
  await expect(v.getByRole('heading', { name: 'We’ve got it' })).toBeVisible();
  await expect(v.getByText(`Plex – Interstellar – ${summary}`)).toBeVisible();
  await expect(v.getByText(ticketNo)).toBeVisible();
  await visitor.close();

  const card = (await api.board()).cards.find((c) => c.title === `Plex – Interstellar – ${summary}`);
  expect(card).toBeTruthy();
  const detail = await api.call<{ ticketNo: string; description: string }>('GET', `/api/cards/${card!.id}`);
  expect(detail.ticketNo).toBe(ticketNo);
  expect(detail.description).toContain('- **Device or app:** Roku');

  // A wrong key shows nothing.
  const stranger = await browser.newContext();
  const x = await stranger.newPage();
  await x.goto('/submit/not-the-right-key-not-the-right-key');
  await expect(x.getByRole('heading', { name: 'This page doesn’t exist' })).toBeVisible();
  await stranger.close();
});

test('Settings: a request type’s labels go on every ticket filed with it, and submitters don’t pick labels', async ({ page, api, browser }) => {
  const s = await api.call<{ submit: { key: string } }>('PUT', '/api/settings/submit', {
    enabled: true,
    columnId: null,
    pageTitle: 'Report a problem',
    intro: 'Tell us what’s wrong.',
  });
  const network = await api.call<{ id: number; name: string }>('POST', '/api/labels', { name: unique('Network'), color: '#4bce97' });
  const family = await api.call<{ id: number; name: string }>('POST', '/api/labels', { name: unique('From family'), color: '#94c748' });
  const typeName = unique('Printer');
  let typeId: number | undefined;
  try {
    // The admin picks the type's labels in Settings → Submit page.
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Add a request type' }).click();
    const editor = page.getByRole('dialog', { name: 'New request type' });
    await editor.getByLabel('Name', { exact: true }).fill(typeName);
    await editor.getByLabel('Ticket title').fill('{summary}');
    const labels = editor.getByRole('group', { name: 'Labels added to every ticket' });
    await labels.getByRole('checkbox', { name: network.name, exact: true }).click();
    await labels.getByRole('checkbox', { name: family.name, exact: true }).click();
    await editor.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(editor).toHaveCount(0);

    const saved = (await api.call<{ id: number; name: string; labelIds: number[] }[]>('GET', '/api/request-types')).find((t) => t.name === typeName);
    expect(saved).toBeTruthy();
    typeId = saved!.id;
    expect([...saved!.labelIds].sort((a, b) => a - b)).toEqual([network.id, family.id].sort((a, b) => a - b));

    // Reopened, the editor shows both labels ticked.
    await page.getByRole('button', { name: `Edit “${typeName}”` }).click();
    const again = page.getByRole('dialog', { name: `Edit “${typeName}”` });
    await expect(again.getByRole('checkbox', { name: network.name, exact: true })).toBeChecked();
    await expect(again.getByRole('checkbox', { name: family.name, exact: true })).toBeChecked();
    await again.getByRole('button', { name: 'Cancel' }).click();

    // A visitor files a ticket of that type, without seeing any labels.
    const summary = unique('paper jam');
    const visitor = await browser.newContext();
    try {
      const v = await visitor.newPage();
      const config = await (await v.request.get(`/api/public/submit/${s.submit.key}`)).json();
      const offered = (config as { types: Record<string, unknown>[] }).types.find((t) => t.name === typeName);
      expect(offered).toBeTruthy();
      expect(offered).not.toHaveProperty('labelIds');
      expect(offered).not.toHaveProperty('tags');

      await v.goto(`/submit/${s.submit.key}`);
      await v.getByRole('radio', { name: typeName }).click();
      await v.getByLabel('Title *').fill(summary);
      await expect(v.getByRole('group', { name: 'Tags' })).toHaveCount(0);
      await expect(v.getByRole('checkbox', { name: network.name })).toHaveCount(0);
      await v.getByLabel('What’s wrong? *').fill('Jams on every page.');
      await v.getByRole('button', { name: 'Send' }).click();
      await expect(v.getByRole('heading', { name: 'Thanks!' })).toBeVisible();
    } finally {
      await visitor.close();
    }

    const card = (await api.board()).cards.find((c) => c.title === summary);
    expect(card).toBeTruthy();
    const detail = await api.call<{ labelIds: number[] }>('GET', `/api/cards/${card!.id}`);
    expect([...detail.labelIds].sort((a, b) => a - b)).toEqual([network.id, family.id].sort((a, b) => a - b));
  } finally {
    // Later specs share the submit page and the label list.
    if (typeId !== undefined) await api.call('DELETE', `/api/request-types/${typeId}`);
    await api.call('DELETE', `/api/labels/${network.id}`);
    await api.call('DELETE', `/api/labels/${family.id}`);
  }
});

test('Settings: create an API token and use it like a monitor would',async ({ page, api: _signedIn, request }) => {
  await page.goto('/settings');
  await page.getByLabel('New token for').fill(unique('Monitor'));
  await page.getByRole('button', { name: 'Create token' }).click();
  const token = (await page.locator('.token-fresh .settings-link-url').first().textContent())!;
  expect(token).toMatch(/^tt_/);

  const title = unique('Backup failed');
  const res = await request.post('/api/v1/cards', {
    headers: { Authorization: `Bearer ${token}` },
    data: { title, priority: 'P1', dedupeKey: title },
  });
  expect(res.status()).toBe(201);
  const again = await request.post('/api/v1/cards', { headers: { Authorization: `Bearer ${token}` }, data: { title, dedupeKey: title } });
  expect((await again.json()).status).toBe('updated');

  await page.getByRole('button', { name: 'Done' }).click();
  await page.reload();
  await expect(page.locator('.token-list')).toContainText('last used');
});

test('Settings: a read-only token reads the summary and can’t open tickets', async ({ page, api: _signedIn, request }) => {
  await page.goto('/settings');
  await page.getByLabel('Only read ticket counts').check();
  await page.getByLabel('New token for').fill(unique('Homepage'));
  await page.getByRole('button', { name: 'Create token' }).click();
  await expect(page.getByText('Homepage: an environment variable for its container')).toBeVisible();
  const token = (await page.locator('.token-fresh .settings-link-url').first().textContent())!;
  const auth = { Authorization: `Bearer ${token}` };

  const summary = await request.get('/api/v1/summary', { headers: auth });
  expect(summary.status()).toBe(200);
  expect(await summary.json()).toMatchObject({ open: expect.any(Number), urgent: expect.any(Number), byPriority: expect.any(Object) });
  const refused = await request.post('/api/v1/cards', { headers: auth, data: { title: unique('Not allowed') } });
  expect(refused.status()).toBe(403);

  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.token-list')).toContainText('read-only');
});

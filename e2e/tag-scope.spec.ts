// Tag-restricted accounts: an admin restricts a member to one tag in Settings → People; signed in
// as that member, only tickets with that tag show, and the board-wide controls are gone. Tickets
// are made through the API (the submit page is rate limited for the whole e2e run; server tests
// cover a submit-page ticket reaching a restricted member).

import { expect, test, tileByTitle, unique } from './helpers';

const HEADERS = { 'X-Requested-With': 'tower-tracker' };
const MEMBER_PASSWORD = 'member password 123';

test('a member restricted to a tag sees only tickets with it', async ({ page, api, browser }) => {
  const username = `t${Math.random().toString(36).slice(2, 8)}`;
  const displayName = unique('Jordan');
  const member = await api.call<{ id: number }>('POST', '/api/users', { username, displayName, role: 'member', password: MEMBER_PASSWORD });
  const tag = await api.call<{ id: number; name: string }>('POST', '/api/labels', { name: unique('Plex').slice(0, 40), color: '#3b82f6' });
  const tagged = await api.createCard({ title: unique('Plex buffering'), labelIds: [tag.id] });
  const untagged = await api.createCard({ title: unique('Furnace filter') });
  const other = await browser.newContext();
  try {
    // The admin restricts them in Settings → People.
    await page.goto('/settings');
    await page.getByRole('button', { name: `Edit ${displayName}` }).click();
    const row = page.locator('.person-row', { hasText: displayName });
    await row.getByLabel('Restrict to tags').check();
    await row.getByLabel(tag.name, { exact: true }).check();
    await row.getByRole('button', { name: 'Save' }).click();
    await expect(row.getByText(`Only: ${tag.name}`)).toBeVisible();

    // Signed in as the member: only the tagged ticket, and no column or tag management.
    const m = await other.newPage();
    const login = await m.request.post('/api/auth/login', { headers: HEADERS, data: { username, password: MEMBER_PASSWORD } });
    expect(login.status()).toBe(204);
    await m.goto('/');
    await expect(tileByTitle(m, tagged.title)).toBeVisible();
    await expect(tileByTitle(m, untagged.title)).toHaveCount(0);
    await expect(m.getByRole('button', { name: /Actions for column/ })).toHaveCount(0);
    expect((await m.request.get(`/api/cards/${untagged.id}`)).status()).toBe(404);
  } finally {
    await other.close();
    await api.call('DELETE', `/api/labels/${tag.id}`);
    // People are never deleted; don't leave an active member behind in the shared database.
    await api.call('PATCH', `/api/users/${member.id}`, { disabled: true });
  }
});

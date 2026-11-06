// Shared setup: sign in through the API (fast) and create test data with the same calls the app
// makes. Requests from `page.request` share the page's cookies, so the UI is signed in too.

import { expect, test as base, type APIRequestContext, type Page } from '@playwright/test';
import { E2E_PASSWORD } from '../playwright.config';

const HEADERS = { 'X-Requested-With': 'tower-tracker' };

export class Api {
  constructor(private readonly request: APIRequestContext) {}

  async call<T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, data?: unknown): Promise<T> {
    const res = await this.request.fetch(url, { method, headers: HEADERS, ...(data === undefined ? {} : { data }) });
    expect(res.ok(), `${method} ${url} → ${res.status()} ${await res.text()}`).toBeTruthy();
    return (res.status() === 204 ? null : await res.json()) as T;
  }

  board() {
    return this.call<{ columns: { id: number; name: string; role: string | null }[]; cards: { id: number; title: string; columnId: number; parentId: number | null }[] }>(
      'GET',
      '/api/board',
    );
  }

  async columnId(name: string): Promise<number> {
    const col = (await this.board()).columns.find((c) => c.name === name);
    if (!col) throw new Error(`no column ${name}`);
    return col.id;
  }

  createCard(body: Record<string, unknown>) {
    return this.call<{ id: number; ticketNo: string; title: string }>('POST', '/api/cards', body);
  }
}

/** A title that won't clash with cards from other tests (they share one database). */
export const unique = (title: string) => `${title} ${Math.random().toString(36).slice(2, 7)}`;

export async function login(page: Page): Promise<void> {
  const res = await page.request.post('/api/auth/login', { headers: HEADERS, data: { password: E2E_PASSWORD, remember: true } });
  expect(res.status()).toBe(204);
}

/** Signed in, with an API helper bound to the page's session. */
export const test = base.extend<{ api: Api }>({
  api: async ({ page }, use) => {
    await login(page);
    await use(new Api(page.request));
  },
});

export { expect };

/** The board column element for a column name. */
export function column(page: Page, name: string) {
  return page.locator('section.column', { has: page.locator('.column-name', { hasText: name }) });
}

/** A tile on the board, by (part of) its title. */
export function tileByTitle(page: Page, title: string) {
  return page.locator('.tile-slot', { hasText: title });
}

/** Drags a card onto another column with real pointer moves (dnd-kit needs several steps). */
export async function dragTo(page: Page, from: ReturnType<Page['locator']>, to: ReturnType<Page['locator']>) {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (!a || !b) throw new Error('drag target not visible');
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2 + 10, { steps: 5 });
  await page.mouse.move(b.x + b.width / 2, b.y + 60, { steps: 20 });
  await page.mouse.move(b.x + b.width / 2, b.y + 70, { steps: 5 });
  await page.mouse.up();
}

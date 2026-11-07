// The interceptor under the real API client: the app's own client.ts and XHR uploads reach the
// demo's routes, and everything else still goes to the network.

import type { BoardResponse } from '@tt/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api/client';
import { seedDemo } from './seed';
import { DemoStore, memoryStorage } from './store';
import { installTransport } from './transport';

const realFetch = vi.fn(async () => new Response('from the network'));
const originalFetch = window.fetch;
const originalXHR = window.XMLHttpRequest;

beforeAll(() => {
  window.fetch = realFetch as unknown as typeof fetch;
  const store = new DemoStore({ storage: memoryStorage(), timeZone: 'America/Chicago', seed: (n, tz) => seedDemo(n, tz) });
  installTransport(store);
});

afterAll(() => {
  window.fetch = originalFetch;
  window.XMLHttpRequest = originalXHR;
});

describe('transport', () => {
  it('answers the real API client from the demo, after a short delay', async () => {
    const started = Date.now();
    const board = await api.get<BoardResponse>('/api/board');
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(board.columns.length).toBe(5);
    expect(realFetch).not.toHaveBeenCalled();
  });

  it("turns the demo's errors into the client's ApiError", async () => {
    const err = await api.post('/api/settings/discord/test').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('demo_unavailable');
    expect((err as ApiError).message).toMatch(/^Not available in the demo/);
  });

  it('answers XMLHttpRequest uploads the same way', async () => {
    const result = await new Promise<{ status: number; body: { error: string } }>((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/backup/restore');
      xhr.setRequestHeader('X-Requested-With', 'tower-tracker');
      xhr.onload = () => resolve({ status: xhr.status, body: JSON.parse(xhr.responseText) as { error: string } });
      const form = new FormData();
      form.append('file', new Blob(['{}']), 'backup.json');
      xhr.send(form);
    });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('demo_unavailable');
  });

  it('leaves other requests alone', async () => {
    const res = await fetch('/assets/app.js');
    expect(await res.text()).toBe('from the network');
    await fetch('https://example.com/api/board');
    expect(realFetch).toHaveBeenCalledTimes(2);
  });
});

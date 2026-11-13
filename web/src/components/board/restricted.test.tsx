// Tag-restricted members: the column controls (rename, menu) are hidden, and the assignee rule.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Column, MeResponse } from '@tt/shared';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canSeeTags } from '../../api/me';
import { ColumnHeader } from './ColumnHeader';

const ME: MeResponse = {
  id: 3,
  username: 'sam',
  displayName: 'Sam',
  role: 'member',
  disabled: false,
  isOwner: false,
  email: null,
  hasPassword: true,
  createdAt: '2026-10-01T15:00:00.000Z',
  disabledAt: null,
  tagScope: null,
  passwordManagedByEnv: false,
  ssoLinked: false,
};
const COLUMN: Column = { id: 1, name: 'Backlog', position: 0, role: null };

function show(me: MeResponse) {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/me') return json(me);
      if (url === '/api/board') return json({ columns: [COLUMN], labels: [], cards: [], blockedColumnId: null, resolutionReasons: [] });
      return json({});
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ColumnHeader column={COLUMN} columns={[COLUMN]} index={0} cardCount={2} nameId="col-1" />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('a tag-restricted member', () => {
  it('gets no column menu or rename', async () => {
    show({ ...ME, tagScope: [7] });
    await vi.waitFor(() => expect(screen.queryByRole('button', { name: /Actions for column/ })).toBeNull());
    expect(await screen.findByText('Backlog')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Backlog' })).toBeNull();
  });

  it('unrestricted members keep them', async () => {
    show(ME);
    expect(await screen.findByRole('button', { name: /Actions for column/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Backlog' })).toBeTruthy();
  });

  it('is only offered cards carrying one of their tags', () => {
    expect(canSeeTags({ tagScope: null }, [])).toBe(true);
    expect(canSeeTags({ tagScope: [7] }, [7, 8])).toBe(true);
    expect(canSeeTags({ tagScope: [7] }, [8])).toBe(false);
    expect(canSeeTags({ tagScope: [7] }, [])).toBe(false);
    expect(canSeeTags({ tagScope: [] }, [7])).toBe(false);
  });
});

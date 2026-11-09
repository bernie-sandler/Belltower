import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CardTile } from '@tt/shared';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { qk } from '../../api/keys';
import { board, tile } from '../../test/fixtures';
import { TileView } from './Tile';

function badge(over: Partial<CardTile>) {
  const qc = new QueryClient();
  qc.setQueryData(qk.board, board([]));
  const { container } = render(
    <QueryClientProvider client={qc}>
      <TileView tile={tile({ checklistTotal: 5, ...over })} labelsById={new Map()} now={Date.now()} />
    </QueryClientProvider>,
  );
  return container.querySelector('.checklist-badge')!;
}

describe('TileView checklist badge', () => {
  it('turns red for any failed item, even when every item is answered', () => {
    const b = badge({ checklistDone: 5, checklistFailed: 1, checklistUnverified: 0 });
    expect(b.className).toContain('is-failed');
    expect(b.className).not.toContain('is-complete');
    expect(b.getAttribute('title')).toBe('Checklist: 5/5, 1 failed');
    expect(b.querySelector('.visually-hidden')?.textContent).toBe('Checklist: 5/5, 1 failed');
  });

  it('turns yellow for an unverified item when nothing failed', () => {
    const b = badge({ checklistDone: 3, checklistFailed: 0, checklistUnverified: 2 });
    expect(b.className).toContain('is-unverified');
    expect(b.getAttribute('title')).toBe('Checklist: 3/5, 2 unverified');
  });

  it('prefers failed over unverified, and is green only when all done', () => {
    expect(badge({ checklistDone: 3, checklistFailed: 1, checklistUnverified: 1 }).getAttribute('title')).toBe(
      'Checklist: 3/5, 1 failed, 1 unverified',
    );
    expect(badge({ checklistDone: 3, checklistFailed: 1, checklistUnverified: 1 }).className).toContain('is-failed');
    expect(badge({ checklistDone: 5 }).className).toContain('is-complete');
    expect(badge({ checklistDone: 4 }).className).toBe('badge checklist-badge');
  });
});

// The title editor and a title changed on another device while you type (a live refresh brings it
// in): Save says so first and keeps your text; saving again replaces theirs on purpose.

import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { CardDetail } from '@tt/shared';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFLICT_MESSAGE } from '../../api/cards';
import { qk } from '../../api/keys';
import { toast } from '../../lib/toast';
import { cardDetail } from '../../test/fixtures';
import { TitleEditor } from './TitleEditor';

vi.mock('../../lib/toast', () => ({ toast: vi.fn() }));

const CARD_ID = 7;

function Harness() {
  const { data } = useQuery<CardDetail>({ queryKey: qk.card(CARD_ID), queryFn: () => new Promise(() => {}), staleTime: Infinity });
  return data ? <TitleEditor card={data} titleId="card-title" onDirtyChange={() => {}} /> : null;
}

/** A fake server for one card that records the PATCH bodies. */
function setup() {
  let server = cardDetail([], { id: CARD_ID, title: 'Printer offline', version: 1 });
  const patches: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === `/api/cards/${CARD_ID}` && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { title: string };
        patches.push(body);
        server = { ...server, title: body.title, version: server.version + 1 };
        return new Response(JSON.stringify(server), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(qk.card(CARD_ID), server);
  render(
    <QueryClientProvider client={qc}>
      <Harness />
    </QueryClientProvider>,
  );
  /** Another device saves a new title, and a refresh brings it into the cache (and on screen). */
  const changeElsewhere = async (title: string) => {
    server = { ...server, title, version: server.version + 1 };
    qc.setQueryData(qk.card(CARD_ID), server);
    await settle();
  };
  return { patches, changeElsewhere };
}

const field = () => screen.getByRole('textbox', { name: 'Card title' }) as HTMLTextAreaElement;
/** Lets cache updates reach the component (TanStack notifies on a timer) and requests finish. */
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

beforeEach(() => vi.mocked(toast).mockClear());
afterEach(() => vi.unstubAllGlobals());

describe('TitleEditor', () => {
  it('saves straight away when nobody else changed the title', async () => {
    const { patches } = setup();
    fireEvent.click(screen.getByRole('button', { name: /Printer offline/ }));
    fireEvent.change(field(), { target: { value: 'Printer offline again' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    await settle();
    expect(patches).toEqual([{ title: 'Printer offline again', expectedVersion: 1 }]);
    expect(toast).not.toHaveBeenCalled();
  });

  it('warns before replacing a title changed elsewhere while you typed, and keeps your text', async () => {
    const { patches, changeElsewhere } = setup();
    fireEvent.click(screen.getByRole('button', { name: /Printer offline/ }));
    fireEvent.change(field(), { target: { value: 'Office printer offline' } });
    await changeElsewhere('Printer offline (2nd floor)');
    // The field shows what saving would replace.
    expect(screen.getByText(/Changed on another device to “Printer offline \(2nd floor\)”/)).toBeTruthy();

    fireEvent.keyDown(field(), { key: 'Enter' });
    await settle();
    expect(patches).toEqual([]);
    expect(toast).toHaveBeenCalledWith(CONFLICT_MESSAGE, { kind: 'warning' });
    expect(field().value).toBe('Office printer offline');
    expect(screen.getByText(/Changed on another device/)).toBeTruthy();

    // Saving again replaces it on purpose.
    fireEvent.keyDown(field(), { key: 'Enter' });
    await settle();
    expect(patches).toEqual([{ title: 'Office printer offline', expectedVersion: 2 }]);
    expect(screen.queryByRole('textbox', { name: 'Card title' })).toBeNull();
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('leaving the field on such a conflict keeps it open and focused, so Esc still cancels', async () => {
    const { patches, changeElsewhere } = setup();
    fireEvent.click(screen.getByRole('button', { name: /Printer offline/ }));
    fireEvent.change(field(), { target: { value: 'Office printer offline' } });
    await changeElsewhere('Printer offline (2nd floor)');
    field().blur();
    await settle();
    expect(patches).toEqual([]);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(field());
    fireEvent.keyDown(field(), { key: 'Escape' });
    await settle();
    expect(screen.queryByRole('textbox', { name: 'Card title' })).toBeNull();
    expect(screen.getByRole('button', { name: /Printer offline \(2nd floor\)/ })).toBeTruthy();
    expect(patches).toEqual([]);
  });
});

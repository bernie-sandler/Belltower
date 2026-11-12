import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Label, RequestType } from '@tt/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { qk } from '../../api/keys';
import { board } from '../../test/fixtures';
import { RequestTypesEditor } from './RequestTypesEditor';

const LABELS: Label[] = [
  { id: 1, name: 'Network', color: '#4bce97', position: 0 },
  { id: 2, name: 'Family', color: '#94c748', position: 1 },
];

const printer: RequestType = {
  id: 5,
  name: 'Printer',
  description: '',
  titlePattern: '{summary}',
  fields: [],
  labelIds: [2],
  position: 0,
  enabled: true,
};

function setup(types: RequestType[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(qk.board, { ...board([]), labels: LABELS });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' || init?.method === 'PUT') return json({ ...printer, ...JSON.parse(String(init.body)) }, init.method === 'POST' ? 201 : 200);
    if (url === '/api/request-types') return json(types);
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  render(
    <QueryClientProvider client={qc}>
      <RequestTypesEditor />
    </QueryClientProvider>,
  );
  const sent = (method: string) => {
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === method);
    return call ? { url: call[0], body: JSON.parse(String(call[1]!.body)) } : undefined;
  };
  return { sent };
}

afterEach(() => vi.unstubAllGlobals());

describe('RequestTypesEditor', () => {
  it('adds a type with the labels every ticket of it gets', async () => {
    const { sent } = setup([]);
    fireEvent.click(screen.getByRole('button', { name: /Add a request type/ }));
    const dialog = screen.getByRole('dialog', { name: 'New request type' });
    const labels = within(dialog).getByRole('group', { name: 'Labels added to every ticket' });
    expect(within(dialog).queryByText('Tags submitters can pick')).toBeNull();
    expect(within(dialog).queryByText('Always add the label')).toBeNull();

    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Network outage' } });
    fireEvent.click(within(labels).getByRole('checkbox', { name: 'Network' }));
    fireEvent.click(within(labels).getByRole('checkbox', { name: 'Family' }));
    expect(within(labels).getByRole('checkbox', { name: 'Network' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(sent('POST')).toBeTruthy());
    expect(sent('POST')).toEqual({
      url: '/api/request-types',
      body: { name: 'Network outage', description: '', titlePattern: '{summary}', fields: [], labelIds: [1, 2], enabled: true },
    });
  });

  it('shows a type’s labels, ticks them in the editor, and saves the new pick', async () => {
    const { sent } = setup([printer]);
    const row = (await screen.findByText('Printer')).closest('li')!;
    expect(within(row).getByText('Family')).toBeTruthy();
    expect(within(row).queryByText('Network')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Edit “Printer”' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit “Printer”' });
    const family = within(dialog).getByRole('checkbox', { name: 'Family' });
    const network = within(dialog).getByRole('checkbox', { name: 'Network' });
    expect(family.getAttribute('aria-checked')).toBe('true');
    expect(network.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(family);
    fireEvent.click(network);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(sent('PUT')).toBeTruthy());
    expect(sent('PUT')!.url).toBe('/api/request-types/5');
    expect(sent('PUT')!.body.labelIds).toEqual([1]);
  });

  it('says where to add labels when there are none', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(qk.board, board([]));
    qc.setQueryData(qk.requestTypes, []);
    render(
      <QueryClientProvider client={qc}>
        <RequestTypesEditor />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Add a request type/ }));
    const labels = screen.getByRole('group', { name: 'Labels added to every ticket' });
    expect(within(labels).getByText('No labels yet. Add some under Menu → Manage labels.')).toBeTruthy();
    expect(within(labels).queryByRole('checkbox')).toBeNull();
  });
});

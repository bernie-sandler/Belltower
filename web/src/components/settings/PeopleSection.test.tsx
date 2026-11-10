import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MeResponse, UserInfo } from '@tt/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PeopleSection } from './PeopleSection';

const person = (over: Partial<UserInfo>): UserInfo => ({
  id: 1,
  username: 'admin',
  displayName: 'Admin',
  role: 'admin',
  disabled: false,
  isOwner: false,
  email: null,
  hasPassword: true,
  createdAt: '2026-10-01T15:00:00.000Z',
  disabledAt: null,
  ...over,
});

const OWNER = person({ id: 1, username: 'admin', displayName: 'Admin', isOwner: true });
const ALEX = person({ id: 2, username: 'alex', displayName: 'Alex Chen', role: 'admin' });
const SAM = person({ id: 3, username: 'sam', displayName: 'Sam Ortiz', role: 'member' });
const KIM = person({ id: 4, username: 'kim', displayName: 'Kim Park', role: 'member', disabled: true, disabledAt: '2026-10-02T15:00:00.000Z', hasPassword: false });

function setup(me: UserInfo, people: UserInfo[], patchReply?: { status: number; body: unknown }) {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/me') return json({ ...me, passwordManagedByEnv: false } satisfies MeResponse);
    if (url === '/api/users' && init?.method === 'POST') return json({ ...SAM, id: 9, ...JSON.parse(String(init.body)) }, 201);
    if (url.startsWith('/api/users/') && init?.method === 'PATCH') return patchReply ? json(patchReply.body, patchReply.status) : json(SAM);
    if (url === '/api/users') return json(people);
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PeopleSection />
    </QueryClientProvider>,
  );
  const sent = (method: string, prefix: string) => {
    const call = fetchMock.mock.calls.find(([url, init]) => url.startsWith(prefix) && init?.method === method);
    return call ? JSON.parse(String(call[1]!.body)) : undefined;
  };
  return { sent };
}

async function openEditor(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: `Edit ${name}` }));
  return screen.getByText(name, { selector: '.person-name' }).closest('li') as HTMLElement;
}

afterEach(() => vi.unstubAllGlobals());

describe('PeopleSection', () => {
  it('lists people with their role, the owner, deactivated accounts and password state', async () => {
    setup(OWNER, [OWNER, ALEX, SAM, KIM]);
    const kim = (await screen.findByText('Kim Park')).closest('li')!;
    expect(within(kim).getByText('Deactivated')).toBeTruthy();
    expect(within(kim).getByText(/no password/)).toBeTruthy();
    const owner = screen.getByText('Admin', { selector: '.person-name' }).closest('li')!;
    expect(within(owner).getByText('Owner')).toBeTruthy();
    expect(within(owner).getByText('You')).toBeTruthy();
  });

  it('offers no deactivate, reset or role change where they could only fail: the owner, yourself', async () => {
    setup(ALEX, [OWNER, ALEX, SAM]);
    const owner = await openEditor('Admin');
    expect(within(owner).queryByRole('button', { name: /Deactivate/ })).toBeNull();
    expect(within(owner).queryByRole('button', { name: /Reset password/ })).toBeNull();
    expect(within(owner).queryByRole('radio')).toBeNull();
    expect(within(owner).getByText('The owner is always an admin.')).toBeTruthy();
    fireEvent.click(within(owner).getByRole('button', { name: 'Close' }));

    const self = await openEditor('Alex Chen');
    expect(within(self).queryByRole('button', { name: /Deactivate/ })).toBeNull();
    expect(within(self).queryByRole('button', { name: /Reset password/ })).toBeNull();
    expect(within(self).getByText(/under Account/)).toBeTruthy();
  });

  it('keeps the only active admin an admin', async () => {
    setup(OWNER, [OWNER, SAM, { ...ALEX, disabled: true }]);
    const owner = await openEditor('Admin');
    expect(within(owner).queryByRole('radio')).toBeNull();
  });

  it('changes a member’s role', async () => {
    const { sent } = setup(OWNER, [OWNER, SAM]);
    const sam = await openEditor('Sam Ortiz');
    fireEvent.click(within(sam).getByLabelText(/^Admin:/));
    fireEvent.click(within(sam).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PATCH', '/api/users/3')).toEqual({ role: 'admin' }));
  });

  it('shows the server’s refusals as friendly messages', async () => {
    setup(OWNER, [OWNER, SAM], { status: 409, body: { error: 'last_admin', message: 'At least one active admin has to remain' } });
    const sam = await openEditor('Sam Ortiz');
    fireEvent.click(within(sam).getByLabelText(/^Admin:/));
    fireEvent.click(within(sam).getByRole('button', { name: 'Save' }));
    expect(await within(sam).findByText(/Make someone else an admin first/)).toBeTruthy();
  });

  it('adds a person with a temporary password', async () => {
    const { sent } = setup(OWNER, [OWNER]);
    fireEvent.click(await screen.findByRole('button', { name: 'Add person' }));
    const form = screen.getByRole('form', { name: 'Add person' });
    fireEvent.change(within(form).getByLabelText(/^Username/), { target: { value: 'Morgan' } });
    fireEvent.change(within(form).getByLabelText(/^Display name/), { target: { value: 'Morgan Lee' } });
    fireEvent.change(within(form).getByLabelText('Temporary password'), { target: { value: 'short' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add person' }));
    expect(await within(form).findByText(/Temporary password: /)).toBeTruthy();
    expect(sent('POST', '/api/users')).toBeUndefined();

    fireEvent.click(within(form).getByRole('button', { name: /Generate/ }));
    const generated = (within(form).getByLabelText('Temporary password') as HTMLInputElement).value;
    expect(generated).toMatch(/^[a-zA-Z2-9]{16}$/);
    fireEvent.click(within(form).getByRole('button', { name: 'Add person' }));
    await waitFor(() => expect(sent('POST', '/api/users')).toEqual({ username: 'morgan', displayName: 'Morgan Lee', role: 'member', password: generated }));
    expect(await screen.findByText(/They sign in as/)).toBeTruthy();
  });
});

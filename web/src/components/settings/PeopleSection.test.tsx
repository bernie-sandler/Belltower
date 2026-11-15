import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MeResponse, UserInfo } from '@tt/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toast } from '../../lib/toast';
import { PeopleSection } from './PeopleSection';

vi.mock('../../lib/toast', () => ({ toast: vi.fn() }));

const person = (over: Partial<UserInfo>): UserInfo => ({
  id: 1,
  username: 'admin',
  displayName: 'Admin',
  role: 'admin',
  disabled: false,
  deleted: false,
  isOwner: false,
  email: null,
  hasPassword: true,
  createdAt: '2026-10-01T15:00:00.000Z',
  disabledAt: null,
  tagScope: null,
  ...over,
});

const OWNER = person({ id: 1, username: 'admin', displayName: 'Admin', isOwner: true });
const ALEX = person({ id: 2, username: 'alex', displayName: 'Alex Chen', role: 'admin' });
const SAM = person({ id: 3, username: 'sam', displayName: 'Sam Ortiz', role: 'member' });
const KIM = person({ id: 4, username: 'kim', displayName: 'Kim Park', role: 'member', disabled: true, disabledAt: '2026-10-02T15:00:00.000Z', hasPassword: false });

const LABELS = [
  { id: 11, name: 'Plex', color: '#112233', position: 0 },
  { id: 12, name: 'Network', color: '#445566', position: 1 },
];

type Reply = { status: number; body: unknown };

function setup(me: UserInfo, people: UserInfo[], patchReply?: Reply, deleteReply: Reply = { status: 200, body: { unassigned: 0 } }) {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/me') return json({ ...me, passwordManagedByEnv: false, ssoLinked: false } satisfies MeResponse);
    if (url === '/api/users' && init?.method === 'POST') return json({ ...SAM, id: 9, ...JSON.parse(String(init.body)) }, 201);
    if (url.startsWith('/api/users/') && init?.method === 'PATCH') return patchReply ? json(patchReply.body, patchReply.status) : json(SAM);
    if (url.startsWith('/api/users/') && init?.method === 'DELETE') return json(deleteReply.body, deleteReply.status);
    if (url === '/api/users') return json(people);
    if (url === '/api/board') return json({ columns: [], labels: LABELS, cards: [], blockedColumnId: null, resolutionReasons: [] });
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
  const called = (method: string, url: string) => fetchMock.mock.calls.some(([u, init]) => u === url && init?.method === method);
  return { sent, called };
}

async function openEditor(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: `Edit ${name}` }));
  return screen.getByText(name, { selector: '.person-name' }).closest('li') as HTMLElement;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(toast).mockClear();
});

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

  it('restricts a member to tags, and lifts it again', async () => {
    const { sent } = setup(OWNER, [OWNER, SAM]);
    const sam = await openEditor('Sam Ortiz');
    fireEvent.click(within(sam).getByLabelText('Restrict to tags'));
    expect(within(sam).getByText(/tickets without tags are hidden/)).toBeTruthy();
    fireEvent.click(await within(sam).findByLabelText('Network'));
    fireEvent.click(within(sam).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PATCH', '/api/users/3')).toEqual({ tagScope: [12] }));
  });

  it('shows a member’s restriction, and lifts it when turned off', async () => {
    const { sent } = setup(OWNER, [OWNER, { ...SAM, tagScope: [11] }]);
    expect(await screen.findByText('Only: Plex')).toBeTruthy();
    const sam = await openEditor('Sam Ortiz');
    fireEvent.click(within(sam).getByLabelText('Restrict to tags'));
    fireEvent.click(within(sam).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PATCH', '/api/users/3')).toEqual({ tagScope: null }));
  });

  it('offers no tag restriction for admins and the owner', async () => {
    setup(OWNER, [OWNER, ALEX, SAM]);
    const owner = await openEditor('Admin');
    expect(within(owner).queryByLabelText('Restrict to tags')).toBeNull();
    fireEvent.click(within(owner).getByRole('button', { name: 'Close' }));
    const alex = await openEditor('Alex Chen');
    expect(within(alex).queryByLabelText('Restrict to tags')).toBeNull();
    fireEvent.click(within(alex).getByRole('button', { name: 'Close' }));
    // Switching a member to admin in the form hides it too.
    const sam = await openEditor('Sam Ortiz');
    expect(within(sam).getByLabelText('Restrict to tags')).toBeTruthy();
    fireEvent.click(within(sam).getByLabelText(/^Admin:/));
    expect(within(sam).queryByLabelText('Restrict to tags')).toBeNull();
  });

  it('warns when no tags are ticked, and ignores tag order when deciding what changed', async () => {
    setup(OWNER, [OWNER, { ...SAM, tagScope: [12, 11] }]);
    const sam = await openEditor('Sam Ortiz');
    // Same tags in another order: nothing to save.
    await within(sam).findByLabelText('Network');
    expect((within(sam).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(sam).getByLabelText('Network'));
    fireEvent.click(within(sam).getByLabelText('Plex'));
    expect(within(sam).getByText('With no tags ticked they see nothing.')).toBeTruthy();
    expect(within(sam).getByLabelText('Restrict to tags').getAttribute('aria-describedby')).toBeTruthy();
  });

  it('leaves deleted people out of the list', async () => {
    const gone = person({ id: 5, username: 'jo', displayName: 'Jo Former', role: 'member', disabled: true, deleted: true, hasPassword: false });
    setup(OWNER, [OWNER, SAM, gone]);
    await screen.findByText('Sam Ortiz');
    expect(screen.queryByText('Jo Former')).toBeNull();
  });

  it('offers no delete for the owner, yourself or the last active admin', async () => {
    setup(ALEX, [OWNER, ALEX, SAM]);
    const owner = await openEditor('Admin');
    expect(within(owner).queryByRole('button', { name: /Delete/ })).toBeNull();
    fireEvent.click(within(owner).getByRole('button', { name: 'Close' }));
    const self = await openEditor('Alex Chen');
    expect(within(self).queryByRole('button', { name: /Delete/ })).toBeNull();
    fireEvent.click(within(self).getByRole('button', { name: 'Close' }));
    // Others can go, active or deactivated.
    const sam = await openEditor('Sam Ortiz');
    expect(within(sam).getByRole('button', { name: /Delete/ })).toBeTruthy();
  });

  it('keeps the last active admin', async () => {
    // Alex is the only active admin (the owner is a member in this fixture only to set that up).
    setup(OWNER, [{ ...OWNER, role: 'member' }, ALEX, SAM]);
    const alex = await openEditor('Alex Chen');
    expect(within(alex).queryByRole('button', { name: /Delete/ })).toBeNull();
  });

  it('deletes someone once their username is typed, and says how many cards were unassigned', async () => {
    const { called } = setup(OWNER, [OWNER, SAM, KIM], undefined, { status: 200, body: { unassigned: 2 } });
    const kim = await openEditor('Kim Park');
    fireEvent.click(within(kim).getByRole('button', { name: /Delete/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Kim Park?' });
    expect(within(dialog).getByText(/can’t be undone/)).toBeTruthy();
    const confirm = within(dialog).getByRole('button', { name: 'Delete for good' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    const input = within(dialog).getByLabelText(/Type kim to confirm/);
    fireEvent.change(input, { target: { value: 'Kim' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'kim' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(called('DELETE', '/api/users/4')).toBe(true));
    await waitFor(() => expect(vi.mocked(toast)).toHaveBeenCalledWith('Deleted Kim Park. 2 open cards are unassigned now.', expect.anything()));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });

  it('shows a refused delete in the dialog', async () => {
    setup(OWNER, [OWNER, SAM], undefined, { status: 409, body: { error: 'cannot_delete_self', message: 'You can’t delete your own account' } });
    const sam = await openEditor('Sam Ortiz');
    fireEvent.click(within(sam).getByRole('button', { name: /Delete/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Type sam to confirm/), { target: { value: 'sam' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete for good' }));
    expect(await within(dialog).findByText(/Another admin can/)).toBeTruthy();
  });
});

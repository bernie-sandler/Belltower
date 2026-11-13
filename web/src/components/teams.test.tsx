// Settings → General → Teams in the browser: with it off the top bar has no Mine or Unassigned,
// cards have no assignee picker or badge, history shows no people's names, and the bell (with its
// sound) is only there for admins while the submit page is on. With it on, all of it is back. The
// switch itself asks before hiding the team features from other people.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ActivityEntry, AppConfig, MeResponse, NotificationsResponse, SettingsResponse, UserInfo } from '@tt/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { qk } from '../api/keys';
import { board, cardDetail, tile } from '../test/fixtures';
import { parseBoardFilter } from './board/FilterBar';
import { TileView } from './board/Tile';
import { ActivityList } from './card/ActivityList';
import { CardFields } from './card/CardFields';
import { PeopleSection } from './settings/PeopleSection';
import { AppearanceSection, TeamsSwitch } from './settings/SettingsPage';
import { ShellContext, type ShellActions } from './shell/ShellContext';
import { TopBar } from './shell/TopBar';

const person = (id: number, username: string, displayName: string, role: 'admin' | 'member'): UserInfo => ({
  id,
  username,
  displayName,
  role,
  disabled: false,
  isOwner: id === 1,
  email: null,
  hasPassword: true,
  createdAt: '2026-10-01T00:00:00.000Z',
  disabledAt: null,
  tagScope: null,
});
const ADMIN = person(1, 'admin', 'Admin', 'admin');
const ALEX = person(2, 'alex', 'Alex Chen', 'admin');
const JORDAN = person(3, 'jordan', 'Jordan Lee', 'member');

const shell: ShellActions = { openLabels: vi.fn(), openNewTicket: vi.fn(), openResolution: vi.fn(), requestAddColumn: vi.fn(), addColumnRequest: 0 };

interface Setup {
  teams: boolean;
  submitPageEnabled?: boolean;
  me?: UserInfo;
  /** null: not loaded (a test fetches it). */
  users?: UserInfo[] | null;
  /** What the bell's last poll said about Teams (default: the same as /api/config). */
  bellTeams?: boolean;
  activity?: ActivityEntry[];
}

/** Everything the components read, already in the cache (nothing is fetched). */
function client({ teams, submitPageEnabled = false, me = ADMIN, users = [ADMIN, ALEX, JORDAN], activity = [], bellTeams = teams }: Setup): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  const config: AppConfig = { appVersion: '1.5.0', timeZone: 'America/Chicago', maxUploadBytes: 1, passwordManagedByEnv: false, teams, submitPageEnabled };
  const meResponse: MeResponse = { ...me, passwordManagedByEnv: false, ssoLinked: false };
  const bell: NotificationsResponse = { items: [], unread: 0, latestId: 0, teams: bellTeams };
  qc.setQueryData(qk.config, config);
  qc.setQueryData(qk.me, meResponse);
  if (users) qc.setQueryData(qk.users, users);
  qc.setQueryData(qk.aiStatus, { enabled: false, model: null });
  qc.setQueryData(qk.notifications, bell);
  qc.setQueryData(qk.board, board([]));
  qc.setQueryData(qk.activity(7), activity);
  return qc;
}

function show(setup: Setup, ui: ReactNode) {
  return render(
    <QueryClientProvider client={client(setup)}>
      <MemoryRouter>
        <ShellContext.Provider value={shell}>{ui}</ShellContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  // Desktop width; the components' queries are all cached, so a fetch would be a bug.
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const navNames = () =>
  within(screen.getByRole('navigation', { name: 'Main' }))
    .getAllByRole('link')
    .map((a) => a.textContent);
const bell = () => screen.queryByRole('button', { name: /^Notifications/ });

describe('the top bar', () => {
  it('has Mine, Unassigned and the bell with Teams on', () => {
    show({ teams: true, me: JORDAN }, <TopBar />);
    expect(navNames()).toEqual(['Board', 'Mine', 'Unassigned', 'Calendar', 'Search', 'Recurring']);
    expect(bell()).not.toBeNull();
  });

  it('has neither with Teams off; the bell comes back for admins while the submit page is on', () => {
    const off = show({ teams: false }, <TopBar />);
    expect(navNames()).toEqual(['Board', 'Calendar', 'Search', 'Recurring']);
    expect(bell()).toBeNull();
    off.unmount();

    const submitOn = show({ teams: false, submitPageEnabled: true }, <TopBar />);
    expect(navNames()).toEqual(['Board', 'Calendar', 'Search', 'Recurring']);
    expect(bell()).not.toBeNull();
    submitOn.unmount();

    // A member never gets submit-page notifications, so there's nothing for a bell to hold.
    show({ teams: false, submitPageEnabled: true, me: JORDAN }, <TopBar />);
    expect(bell()).toBeNull();
  });
});

describe('Teams switched somewhere else', () => {
  it('reaches this tab with the bell’s next poll: the app shell reloads /api/config', async () => {
    const fetched: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        fetched.push(url);
        if (url !== '/api/config') throw new Error(`unexpected fetch ${url}`);
        const config: AppConfig = { appVersion: '1.5.0', timeZone: 'America/Chicago', maxUploadBytes: 1, passwordManagedByEnv: false, teams: true, submitPageEnabled: true };
        return new Response(JSON.stringify(config), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    // This tab still thinks Teams is off; the bell's poll says another admin turned it on.
    show({ teams: false, submitPageEnabled: true, bellTeams: true }, <TopBar />);
    await waitFor(() => expect(navNames()).toEqual(['Board', 'Mine', 'Unassigned', 'Calendar', 'Search', 'Recurring']));
    expect(fetched).toEqual(['/api/config']);
  });
});

describe('Settings → Appearance', () => {
  it('offers the bell’s sound only where there’s a bell', () => {
    const hasSound = (teams: boolean, submitPageEnabled: boolean, me = JORDAN) => {
      const r = show({ teams, submitPageEnabled, me }, <AppearanceSection />);
      const has = screen.queryByRole('radiogroup', { name: 'Sound for new notifications' }) !== null;
      expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeTruthy();
      r.unmount();
      return has;
    };
    expect(hasSound(true, false)).toBe(true);
    expect(hasSound(false, true)).toBe(false); // a member
    expect(hasSound(false, true, ADMIN)).toBe(true);
    expect(hasSound(false, false, ADMIN)).toBe(false);
  });
});

describe('cards', () => {
  it('have the assignee picker and the tile badge with Teams on only', () => {
    const card = cardDetail([], { assigneeId: JORDAN.id });
    const on = show({ teams: true }, <CardFields card={card} readOnly={false} />);
    expect(screen.getByLabelText(/Assignee/)).toHaveProperty('value', String(JORDAN.id));
    on.unmount();
    show({ teams: false }, <CardFields card={card} readOnly={false} />);
    expect(screen.queryByLabelText(/Assignee/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Assign to me' })).toBeNull();
  });

  it('show the assignee’s initials on the tile with Teams on only', () => {
    const t = tile({ assigneeId: JORDAN.id });
    const on = show({ teams: true }, <TileView tile={t} labelsById={new Map()} now={Date.now()} />);
    expect(on.container.querySelector('.assignee-badge')?.getAttribute('title')).toBe('Assigned to Jordan Lee');
    on.unmount();
    const off = show({ teams: false }, <TileView tile={t} labelsById={new Map()} now={Date.now()} />);
    expect(off.container.querySelector('.assignee-badge')).toBeNull();
  });

  it('ignore a leftover ?assignee= in the address with Teams off', () => {
    const params = new URLSearchParams('assignee=me,3&prio=P1');
    expect(parseBoardFilter(params, true)).toMatchObject({ assignees: ['me', '3'], priorities: ['P1'] });
    expect(parseBoardFilter(params, false)).toMatchObject({ assignees: [], priorities: ['P1'] });
  });
});

describe('history', () => {
  const at = '2026-10-27T15:00:00.000Z';
  const base = { cardId: 7, bodyMd: null, occurredAt: at, createdAt: at, editedAt: null, retractedAt: null, revisionCount: 0, tokenId: null };
  const entries: ActivityEntry[] = [
    { ...base, id: 4, kind: 'worklog', type: 'worklog', data: {}, bodyMd: 'Swapped it, @jordan can you check?', userId: 2, userName: 'Alex Chen', userUsername: 'alex' },
    { ...base, id: 3, kind: 'event', type: 'assigned', data: { from: null, to: 3, toName: 'Jordan Lee' }, userId: 2, userName: 'Alex Chen', userUsername: 'alex' },
    { ...base, id: 2, kind: 'event', type: 'priority_changed', data: { from: null, to: 'P1' }, userId: 1, userName: 'Admin', userUsername: 'admin', tokenId: 5, tokenName: 'Kuma' },
    { ...base, id: 1, kind: 'event', type: 'created', data: { column: { name: 'Triage' }, via: 'submit page (Sam)' }, userId: null },
  ];
  const by = () => [...document.querySelectorAll('.activity-by')].map((el) => [el.textContent, el.getAttribute('title')]);

  it('names people, with @username on hover, and highlights mentions, with Teams on', () => {
    const { container } = show({ teams: true, activity: entries }, <ActivityList cardId={7} readOnly composeRequest={0} />);
    expect(by()).toEqual([
      ['Alex Chen', '@alex'],
      ['Alex Chen', '@alex'],
      ['via API token “Kuma” (Admin)', '@admin'],
      ['submit page (Sam)', null],
    ]);
    expect(container.querySelector('.activity-body .mention')?.textContent).toBe('@jordan');
    expect(screen.getByText(/Assigned this to Jordan Lee/)).toBeTruthy();
  });

  it('leaves people out with Teams off, keeping tokens and how a card came in; @name is plain text', () => {
    const { container } = show({ teams: false, activity: entries }, <ActivityList cardId={7} readOnly composeRequest={0} />);
    expect(by()).toEqual([
      ['via API token “Kuma”', null],
      ['submit page (Sam)', null],
    ]);
    expect(container.querySelector('.mention')).toBeNull();
    expect(container.querySelector('.activity-body')?.textContent).toContain('@jordan can you check?');
    expect(screen.queryByText(/Assigned this to/)).toBeNull();
  });
});

describe('Settings → General → Teams', () => {
  const settings = (enabled: boolean) => ({ teams: { enabled } }) as SettingsResponse;
  let puts: unknown[];
  beforeEach(() => {
    puts = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url !== '/api/settings/teams' || init?.method !== 'PUT') throw new Error(`unexpected fetch ${url}`);
        const body = JSON.parse(String(init.body)) as { enabled: boolean };
        puts.push(body);
        return new Response(JSON.stringify(settings(body.enabled)), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
  });
  const teamsSwitch = () => screen.getByRole('switch', { name: 'Teams' });

  it('turns on straight away', async () => {
    show({ teams: false }, <TeamsSwitch s={settings(false)} />);
    expect(teamsSwitch()).toHaveProperty('checked', false);
    expect(screen.getByText('Assign cards to people, Mine and Unassigned, watching, @mentions and the notification bell')).toBeTruthy();
    fireEvent.click(teamsSwitch());
    await waitFor(() => expect(puts).toEqual([{ enabled: true }]));
  });

  it('asks before turning off while other people use the board', async () => {
    show({ teams: true }, <TeamsSwitch s={settings(true)} />);
    fireEvent.click(teamsSwitch());
    const dialog = screen.getByRole('dialog', { name: 'Turn off Teams?' });
    expect(dialog.textContent).toContain(
      '2 other people have accounts here. Turning Teams off hides assignees, Mine, watching and the bell for everyone, and stops their personal Discord and ntfy messages. Nothing is deleted.',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(puts).toEqual([]);
    expect(teamsSwitch()).toHaveProperty('checked', true);

    fireEvent.click(teamsSwitch());
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Turn off Teams?' })).getByRole('button', { name: 'Turn off Teams' }));
    await waitFor(() => expect(puts).toEqual([{ enabled: false }]));
  });

  it('says so when the people list can’t load, and asks before turning off anyway', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/users') return new Response(JSON.stringify({ error: 'internal', message: 'Database is locked' }), { status: 500, headers: { 'content-type': 'application/json' } });
        if (url === '/api/settings/teams' && init?.method === 'PUT') {
          puts.push(JSON.parse(String(init.body)));
          return new Response(JSON.stringify(settings(false)), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    show({ teams: true, users: null }, <TeamsSwitch s={settings(true)} />);
    expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t load the people list');
    expect(teamsSwitch()).toHaveProperty('disabled', false);
    fireEvent.click(teamsSwitch());
    const dialog = screen.getByRole('dialog', { name: 'Turn off Teams?' });
    expect(dialog.textContent).toContain('Other people may have accounts here.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn off Teams' }));
    await waitFor(() => expect(puts).toEqual([{ enabled: false }]));
  });

  it('turns off without asking when nobody else is active', async () => {
    show({ teams: true, users: [ADMIN, { ...JORDAN, disabled: true, disabledAt: '2026-10-02T00:00:00.000Z' }] }, <TeamsSwitch s={settings(true)} />);
    fireEvent.click(teamsSwitch());
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(puts).toEqual([{ enabled: false }]));
  });
});

describe('Settings → People', () => {
  const HINT = 'Turn on Teams in General to assign cards to people';

  it('points to Teams while it’s off and more than one person is active', () => {
    const r = show({ teams: false }, <PeopleSection />);
    expect(screen.getByText(HINT)).toBeTruthy();
    r.unmount();
    const on = show({ teams: true }, <PeopleSection />);
    expect(screen.queryByText(HINT)).toBeNull();
    on.unmount();
    show({ teams: false, users: [ADMIN, { ...ALEX, disabled: true, disabledAt: '2026-10-02T00:00:00.000Z' }] }, <PeopleSection />);
    expect(screen.queryByText(HINT)).toBeNull();
  });
});

import { Archive, CalendarDays, Columns3, DatabaseBackup, FilePlus2, FileUp, KanbanSquare, ListPlus, LogOut, Menu as MenuIcon, Plus, Repeat, Search, Settings, Sparkles, Tag, Trash2, UserRound } from 'lucide-react';
import { cls } from '../../lib/cls';
import { Link, useLocation, useNavigate } from 'react-router';
import { backgroundOf } from '../../lib/navigation';
import { useState } from 'react';
import { useLogout } from '../../api/auth';
import { useIsAdmin } from '../../api/me';
import { useAiStatus } from '../../api/tickets';
import { BrandMark } from '../common/BrandMark';
import { Menu } from '../common/Menu';
import { useShell } from './ShellContext';

const NAV = [
  { to: '/', label: 'Board', icon: KanbanSquare },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays },
  { to: '/search', label: 'Search', icon: Search },
  { to: '/templates', label: 'Recurring', icon: Repeat },
] as const;

/** Pages reached from the menu; shown in the nav while open. */
const EXTRA_PAGES: Record<string, string> = {
  '/archive': 'Archive',
  '/trash': 'Trash',
  '/import': 'Import',
  '/backup': 'Backup',
  '/settings': 'Settings',
  '/account': 'Account',
};

export function TopBar() {
  const shell = useShell();
  const logout = useLogout();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null);
  const aiEnabled = useAiStatus().data?.enabled === true;
  const isAdmin = useIsAdmin();
  const location = useLocation();
  const navigate = useNavigate();
  const page = (backgroundOf(location) ?? location).pathname;

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <BrandMark size={24} />
        <span className="topbar-name">Belltower</span>
      </div>
      <nav className="topnav" aria-label="Main">
        {NAV.map(({ to, label, icon: Icon }) => {
          const current = to === '/' ? page === '/' || page.startsWith('/cards') : page.startsWith(to);
          return (
            <Link key={to} to={to} className={cls('topnav-item', current && 'is-current')} aria-current={current ? 'page' : undefined}>
              <Icon size={16} aria-hidden />
              <span className="topnav-label">{label}</span>
            </Link>
          );
        })}
        {EXTRA_PAGES[page] && (
          <span className="topnav-item is-current" aria-current="page">
            {EXTRA_PAGES[page]}
          </span>
        )}
      </nav>
      <div className="topbar-spacer" />
      <button
        type="button"
        className="btn btn-primary btn-sm topbar-add-btn"
        aria-haspopup="menu"
        aria-expanded={addAnchor !== null}
        aria-label="Add ticket"
        onClick={(e) => setAddAnchor(addAnchor ? null : e.currentTarget)}
      >
        <Plus size={16} aria-hidden />
        <span className="topbar-add-label">Add ticket</span>
      </button>
      {addAnchor && (
        <Menu
          anchor={addAnchor}
          onClose={() => setAddAnchor(null)}
          label="Add ticket"
          items={[
            ...(aiEnabled
              ? [
                  {
                    key: 'describe',
                    label: 'Describe the issue',
                    hint: 'Claude drafts the ticket for you to review',
                    icon: <Sparkles size={16} />,
                    onSelect: () => shell.openNewTicket('describe'),
                  },
                  {
                    key: 'many',
                    label: 'Describe several issues',
                    hint: 'Paste notes or logs; Claude splits them into cards',
                    icon: <ListPlus size={16} />,
                    onSelect: () => shell.openNewTicket('many'),
                  },
                ]
              : []),
            {
              key: 'blank',
              label: 'Blank ticket',
              hint: 'Fill in every field yourself',
              icon: <FilePlus2 size={16} />,
              onSelect: () => shell.openNewTicket('blank'),
            },
            ...(aiEnabled
              ? []
              : [
                  {
                    key: 'import',
                    label: 'Import from JSON',
                    hint: 'Paste cards written by an AI chat',
                    icon: <FileUp size={16} />,
                    onSelect: () => void navigate('/import'),
                  },
                ]),
          ]}
        />
      )}
      <button
        type="button"
        className="icon-btn topbar-menu-btn"
        aria-label="Main menu"
        aria-haspopup="menu"
        aria-expanded={menuAnchor !== null}
        onClick={(e) => setMenuAnchor(menuAnchor ? null : e.currentTarget)}
      >
        <MenuIcon size={20} aria-hidden />
      </button>
      {menuAnchor && (
        <Menu
          anchor={menuAnchor}
          onClose={() => setMenuAnchor(null)}
          label="Main menu"
          items={[
            { key: 'labels', label: 'Manage labels', icon: <Tag size={16} />, onSelect: shell.openLabels },
            { key: 'column', label: 'Add column', icon: <Columns3 size={16} />, onSelect: shell.requestAddColumn },
            { key: 'archive', label: 'Archive', icon: <Archive size={16} />, onSelect: () => void navigate('/archive') },
            { key: 'trash', label: 'Trash', icon: <Trash2 size={16} />, onSelect: () => void navigate('/trash') },
            'separator',
            ...(aiEnabled
              ? []
              : [{ key: 'import', label: 'Import cards', icon: <FileUp size={16} />, onSelect: () => void navigate('/import') }]),
            ...(isAdmin
              ? [{ key: 'backup', label: 'Backup & restore', icon: <DatabaseBackup size={16} />, onSelect: () => void navigate('/backup') }]
              : []),
            { key: 'settings', label: 'Settings', icon: <Settings size={16} />, onSelect: () => void navigate('/settings') },
            'separator',
            { key: 'account', label: 'Account', icon: <UserRound size={16} />, onSelect: () => void navigate('/account') },
            {
              key: 'logout',
              label: logout.isPending ? 'Logging out…' : 'Log out',
              icon: <LogOut size={16} />,
              disabled: logout.isPending,
              onSelect: () => logout.mutate(),
            },
          ]}
        />
      )}
    </header>
  );
}

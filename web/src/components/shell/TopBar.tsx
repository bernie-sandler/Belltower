import { Archive, Columns3, LogOut, Menu as MenuIcon, Settings, Tag, Trash2 } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router';
import { backgroundOf } from '../../lib/navigation';
import { useState } from 'react';
import { useLogout } from '../../api/auth';
import { BrandMark } from '../common/BrandMark';
import { Menu } from '../common/Menu';
import { useShell } from './ShellContext';

export function TopBar() {
  const shell = useShell();
  const logout = useLogout();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const page = (backgroundOf(location) ?? location).pathname;
  const pageName = page === '/archive' ? 'Archive' : page === '/trash' ? 'Trash' : 'Board';

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <BrandMark size={24} />
        <span className="topbar-name">Tower Tracker</span>
      </div>
      {/* Main navigation. Calendar, Search and Templates join "Board" here in later phases. */}
      <nav className="topnav" aria-label="Main">
        {pageName === 'Board' ? (
          <h1 className="topnav-item is-current" aria-current="page">
            Board
          </h1>
        ) : (
          <>
            <Link className="topnav-item" to="/">
              Board
            </Link>
            <h1 className="topnav-item is-current" aria-current="page">
              {pageName}
            </h1>
          </>
        )}
      </nav>
      <div className="topbar-spacer" />
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
            { key: 'settings', label: 'Settings', icon: <Settings size={16} />, onSelect: shell.openSettings },
            'separator',
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

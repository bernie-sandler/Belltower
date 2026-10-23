import { Columns3, LogOut, Menu as MenuIcon, Settings, Tag } from 'lucide-react';
import { useState } from 'react';
import { useLogout } from '../../api/auth';
import { BrandMark } from '../common/BrandMark';
import { Menu } from '../common/Menu';
import { useShell } from './ShellContext';

export function TopBar() {
  const shell = useShell();
  const logout = useLogout();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <BrandMark size={24} />
        <span className="topbar-name">Tower Tracker</span>
      </div>
      {/* Main navigation. Calendar, Search and Templates join "Board" here in later phases. */}
      <nav className="topnav" aria-label="Main">
        <h1 className="topnav-item is-current" aria-current="page">
          Board
        </h1>
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

import type { KeyboardEvent, ReactNode } from 'react';
import { cls } from '../../lib/cls';
import { afterLayersSettle } from '../../lib/layers';
import { Popover } from './Popover';

export interface MenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Secondary line, e.g. why an item is disabled. */
  hint?: string;
}

export type MenuEntry = MenuItem | 'separator';

interface MenuProps {
  anchor: HTMLElement;
  onClose: () => void;
  items: MenuEntry[];
  label: string;
  placement?: 'bottom-start' | 'bottom-end';
}

/** Moves focus between items with the arrow keys, Home and End (disabled items stay reachable). */
function onMenuKeyDown(e: KeyboardEvent<HTMLDivElement>) {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(e.key)) return;
  e.preventDefault();
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
  if (items.length === 0) return;
  const i = items.indexOf(document.activeElement as HTMLButtonElement);
  let next = 0;
  if (e.key === 'ArrowDown') next = i < 0 ? 0 : (i + 1) % items.length;
  if (e.key === 'ArrowUp') next = i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length;
  if (e.key === 'End') next = items.length - 1;
  items[next]?.focus();
}

export function Menu({ anchor, onClose, items, label, placement = 'bottom-end' }: MenuProps) {
  return (
    <Popover
      anchor={anchor}
      onClose={onClose}
      role="menu"
      ariaLabel={label}
      className="menu"
      placement={placement}
      onKeyDown={onMenuKeyDown}
    >
      {items.map((item, i) => {
        if (item === 'separator') return <div key={`sep-${i}`} role="separator" className="menu-sep" />;
        return (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            className={cls('menu-item', item.danger && 'is-danger')}
            // aria-disabled (not `disabled`) keeps the item focusable, so its hint is announced.
            aria-disabled={item.disabled || undefined}
            onClick={() => {
              if (item.disabled) return;
              onClose();
              // Run the action once the menu's history entry is gone, so an action that navigates
              // (e.g. opening a card) doesn't land on top of it.
              afterLayersSettle(item.onSelect);
            }}
          >
            {item.icon && (
              <span className="menu-item-icon" aria-hidden="true">
                {item.icon}
              </span>
            )}
            <span className="menu-item-text">
              <span>{item.label}</span>
              {item.hint && (
                <span className="menu-item-hint">
                  {item.hint}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </Popover>
  );
}

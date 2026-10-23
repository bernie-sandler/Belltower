// Floating panel anchored to a button (menus, the label picker). Rendered in a portal with
// fixed positioning, flipped above the anchor when there's no room below. Closes on outside
// pointer-down, Esc / Back (layer stack), or when an ancestor of the anchor scrolls.
//
// Position is written straight to the element's CSSOM style in a layout effect (CSP-safe, no
// second render), so the panel is visible — and therefore focusable — by the time focus moves in.

import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cls } from '../../lib/cls';
import { focusableIn, restoreFocus, trapTab } from '../../lib/focus';
import { useLayer } from '../../lib/layers';

export interface PopoverProps {
  anchor: HTMLElement;
  onClose: () => void;
  children: ReactNode;
  placement?: 'bottom-start' | 'bottom-end';
  className?: string;
  /** 'menu' closes on Tab (menu semantics); anything else keeps Tab inside the panel. */
  role?: string;
  ariaLabel?: string;
  /** Where focus goes on open: first focusable child (menus) or the panel. */
  focus?: 'first' | 'panel';
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
}

const MARGIN = 8;
const GAP = 4;

export function Popover({
  anchor,
  onClose,
  children,
  placement = 'bottom-start',
  className,
  role,
  ariaLabel,
  focus = 'first',
  onKeyDown,
}: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);

  useEffect(() => {
    closeRef.current = onClose;
  });

  // A history layer: Esc and the phone's Back gesture close the popover, not the page under it.
  useLayer(true, onClose, { history: true });

  // Position next to the anchor (measure, then place).
  useLayoutEffect(() => {
    const place = () => {
      const el = ref.current;
      if (!el) return;
      el.style.maxHeight = '';
      const a = anchor.getBoundingClientRect();
      const vw = document.documentElement.clientWidth || window.innerWidth;
      const vh = window.innerHeight;
      const w = el.offsetWidth;
      const h = el.scrollHeight;
      const below = vh - a.bottom - GAP - MARGIN;
      const above = a.top - GAP - MARGIN;
      const maxHeight = Math.max(120, Math.max(below, above));
      const height = Math.min(h, maxHeight);
      const placeBelow = height <= below || below >= above;
      const top = placeBelow ? a.bottom + GAP : Math.max(MARGIN, a.top - GAP - height);
      let left = placement === 'bottom-end' ? a.right - w : a.left;
      left = Math.max(MARGIN, Math.min(left, vw - w - MARGIN));
      el.style.top = `${Math.round(top)}px`;
      el.style.left = `${Math.round(left)}px`;
      el.style.maxHeight = `${Math.floor(maxHeight)}px`;
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor, placement]);

  // Focus in on open; give focus back to the anchor on close if it was inside.
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const target = focus === 'first' ? (focusableIn(el)[0] ?? el) : el;
    target.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      if (!active || active === document.body || el.contains(active)) restoreFocus(anchor);
    };
  }, [anchor, focus]);

  // Outside pointer-down and ancestor scroll close the popover.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t || ref.current?.contains(t) || anchor.contains(t)) return;
      closeRef.current();
    };
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && ref.current?.contains(t)) return;
      if (t === document || (t instanceof Node && t.contains(anchor))) closeRef.current();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [anchor]);

  return createPortal(
    <div
      ref={ref}
      className={cls('popover', className)}
      role={role}
      aria-label={ariaLabel}
      tabIndex={-1}
      onKeyDown={(e) => {
        // Only handle keys pressed inside this panel (React bubbles events from nested portals).
        if (!ref.current?.contains(e.target as Node)) return;
        if (e.key === 'Tab') {
          if (role === 'menu') {
            // Menu semantics: Tab leaves the menu; focus goes back to the button that opened it.
            e.preventDefault();
            onClose();
          } else if (ref.current) {
            trapTab(e, ref.current);
          }
        }
        onKeyDown?.(e);
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

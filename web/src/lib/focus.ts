// `:enabled` (rather than :not([disabled])) also respects a disabled <fieldset>.
const FOCUSABLE = [
  'a[href]',
  'button:enabled',
  'input:enabled:not([type="hidden"]):not([hidden])',
  'select:enabled',
  'textarea:enabled',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

const FIELDS = [
  'input:enabled:not([type="hidden"]):not([hidden]):not([readonly])',
  'textarea:enabled:not([readonly])',
  'select:enabled',
].join(', ');

/** Visible, focusable descendants in DOM order. */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);
}

/** The element a dialog should focus first: [data-autofocus], else the first field, else the panel. */
export function initialFocusTarget(panel: HTMLElement): HTMLElement {
  const preferred = panel.querySelector<HTMLElement>('[data-autofocus]');
  if (preferred) return preferred;
  const field = Array.from(panel.querySelectorAll<HTMLElement>(FIELDS)).find((el) => el.getClientRects().length > 0);
  return field ?? panel;
}

/** Keeps Tab / Shift+Tab inside `root`. Call from the container's keydown handler. */
export function trapTab(e: { key: string; shiftKey: boolean; preventDefault: () => void }, root: HTMLElement): void {
  if (e.key !== 'Tab') return;
  const items = focusableIn(root);
  if (items.length === 0) {
    e.preventDefault();
    return;
  }
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const active = document.activeElement;
  if (!active || !root.contains(active)) {
    // Focus fell out (e.g. the focused button was disabled or removed): bring it back inside.
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  } else if (e.shiftKey && (active === first || active === root)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

export function restoreFocus(el: Element | null): void {
  if (el instanceof HTMLElement && el.isConnected) el.focus({ preventScroll: true });
}

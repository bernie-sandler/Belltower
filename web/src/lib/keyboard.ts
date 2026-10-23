// One document-level keydown handler for global shortcuts.
//  - Esc closes the topmost layer (menu → sheet/dialog → card route). Fields that use Esc
//    themselves (inline editors, composers) call preventDefault, which leaves it to them.
//  - Letter shortcuts ('n' = new card in Triage) only fire on the bare board: never while
//    typing, with Ctrl/Meta/Alt held, during IME composition, while dragging, or with a layer open.
//  - '/' is reserved for search (Phase 3) and does nothing yet.

import { useEffect, useRef } from 'react';
import { isDragging } from './dragging';
import { closeTopLayer, hasLayers } from './layers';

type Handler = () => void;
const handlers = new Map<string, Handler[]>();

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'));
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.isComposing) return;
  if (isDragging()) return;

  if (e.key === 'Escape') {
    if (closeTopLayer()) e.preventDefault();
    return;
  }

  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (isEditableTarget(e.target)) return;
  if (hasLayers()) return;

  const list = handlers.get(e.key);
  const handler = list?.[list.length - 1];
  if (handler) {
    e.preventDefault();
    handler();
  }
}

let installed = false;

export function installGlobalKeyboard(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('keydown', onKeyDown);
}

/** Binds a single-key shortcut (e.key value) while mounted; the latest binding wins. */
export function useShortcut(key: string, handler: Handler, enabled = true): void {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    if (!enabled) return undefined;
    const fn: Handler = () => ref.current();
    const list = handlers.get(key) ?? [];
    list.push(fn);
    handlers.set(key, list);
    return () => {
      const current = handlers.get(key);
      const i = current?.indexOf(fn) ?? -1;
      if (current && i >= 0) current.splice(i, 1);
    };
  }, [key, enabled]);
}

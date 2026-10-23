// Overlay layer stack. Menus, popovers, sheets, dialogs and the card route register here so that
// Esc — and the browser Back button / iOS swipe-back — close only the topmost layer.
//
// Back support: each "history" layer (menus, popovers, dialogs, sheets) is mirrored by one
// sentinel history entry, a copy of the current entry (same URL, same router state) plus a depth
// marker. Back pops a sentinel; we see the popstate and close the top layer. When the UI closes a
// layer instead, its sentinel is consumed with history.go(-n). React Router sees the same location
// throughout. The count of sentinels is reconciled in a microtask, so open/close churn in one tick
// (React StrictMode, a menu item that opens a dialog) causes no extra history traffic.
//
// History work is serialized: at most one history.go() is in flight, and anything that needs the
// history to be settled first (route changes, closing the card) waits for it via whenHistoryIdle().
// Otherwise a navigation could land on top of a sentinel that is about to be popped.

import { useEffect, useRef } from 'react';

interface LayerEntry {
  close: () => void;
  history: boolean;
  modal: boolean;
}

interface LayerOptions {
  /** Mirror the layer with a history entry so Back closes it (menus, popovers, dialogs, sheets). */
  history?: boolean;
  /** Make the app root inert while open (dialogs, sheets, the card modal). */
  modal?: boolean;
}

const MARK = '__ttLayer';
const stack: LayerEntry[] = [];
let traversalPending = false;
let traversalToken = 0;
let afterTraversal: (() => void) | null = null;
let reconcileQueued = false;
/** Work waiting for the history to settle (no traversal in flight, sentinels reconciled). */
const waiting: Array<() => void> = [];

function historyState(): Record<string, unknown> {
  const s: unknown = window.history.state;
  return s && typeof s === 'object' ? (s as Record<string, unknown>) : {};
}

/** Number of sentinel entries at and below the current history entry. */
function currentDepth(): number {
  const v = historyState()[MARK];
  return typeof v === 'number' ? v : 0;
}

function wantedDepth(): number {
  let n = 0;
  for (const e of stack) if (e.history) n += 1;
  return n;
}

function applyInert(): void {
  const root = document.getElementById('root');
  if (root) root.inert = stack.some((e) => e.modal);
}

function go(delta: number, then?: () => void): void {
  if (delta === 0) {
    // history.go(0) reloads the page.
    then?.();
    queueReconcile();
    return;
  }
  traversalPending = true;
  afterTraversal = then ?? null;
  const token = ++traversalToken;
  window.history.go(delta);
  // history.go() past the start of the session fires no popstate; don't wait forever.
  window.setTimeout(() => {
    if (traversalPending && token === traversalToken) finishTraversal();
  }, 1500);
}

function finishTraversal(): void {
  traversalPending = false;
  const cb = afterTraversal;
  afterTraversal = null;
  cb?.();
  queueReconcile();
}

function pushSentinel(depth: number): void {
  try {
    window.history.pushState({ ...historyState(), [MARK]: depth }, '');
  } catch {
    // Safari throttles pushState (SecurityError after ~100 calls in 10 s). The layer still works;
    // Back just won't close it this time.
  }
}

function flushWaiting(): void {
  while (waiting.length > 0 && !traversalPending && !reconcileQueued) waiting.shift()!();
}

function reconcile(): void {
  reconcileQueued = false;
  if (traversalPending) return; // finishTraversal() reconciles again
  const want = wantedDepth();
  const have = currentDepth();
  if (want > have) {
    for (let d = have + 1; d <= want; d += 1) pushSentinel(d);
  } else if (want < have) {
    go(want - have);
    return;
  }
  flushWaiting();
}

function queueReconcile(): void {
  if (reconcileQueued) return;
  reconcileQueued = true;
  queueMicrotask(reconcile);
}

function onPopState(): void {
  if (traversalPending) {
    finishTraversal();
    return;
  }
  // The user went Back (or Forward). Close layers from the top until the number of open
  // history layers matches the sentinel depth we landed on.
  const have = currentDepth();
  let open = wantedDepth();
  while (open > have && stack.length > 0) {
    const top = stack.pop()!;
    if (top.history) open -= 1;
    top.close();
  }
  applyInert();
  queueReconcile();
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', onPopState);
}

/** Registers a layer; returns the unregister function. */
export function pushLayer(close: () => void, opts: LayerOptions = {}): () => void {
  const entry: LayerEntry = { close, history: opts.history ?? false, modal: opts.modal ?? false };
  stack.push(entry);
  applyInert();
  if (entry.history) queueReconcile();
  return () => {
    const i = stack.indexOf(entry);
    if (i < 0) return; // already removed by a Back press
    stack.splice(i, 1);
    applyInert();
    queueReconcile();
  };
}

/** Asks the topmost layer to close (Esc). Returns false when nothing is open. */
export function closeTopLayer(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.close();
  return true;
}

export function hasLayers(): boolean {
  return stack.length > 0;
}

/**
 * Runs `fn` once the history is settled: right away when nothing is pending, otherwise after the
 * in-flight traversal and sentinel reconciliation. Use it for navigation (router push/replace)
 * that may follow closing a layer, so the new entry isn't pushed on top of a dying sentinel.
 */
export function whenHistoryIdle(fn: () => void): void {
  if (!traversalPending && !reconcileQueued && waiting.length === 0) fn();
  else waiting.push(fn);
}

/**
 * Runs `fn` after the layer changes caused by the current event (e.g. a menu closing) have been
 * committed by React and their history entries settled. Menus use this for item actions.
 */
export function afterLayersSettle(fn: () => void): void {
  window.setTimeout(() => whenHistoryIdle(fn), 0);
}

/**
 * Leaves the current route by going back `steps` real history entries, also discarding the
 * sentinels of any layers open on top of it (they unmount with the route).
 */
export function routeBack(steps = 1): void {
  for (const e of stack) e.history = false;
  whenHistoryIdle(() => go(-(currentDepth() + steps)));
}

/** Discards open layers' sentinels, then runs `navigate` (e.g. a replace to another route). */
export function unwindThen(navigate: () => void): void {
  for (const e of stack) e.history = false;
  whenHistoryIdle(() => {
    const depth = currentDepth();
    if (depth > 0) go(-depth, navigate);
    else navigate();
  });
}

/**
 * Registers a layer while `active` is true. `onClose` may change between renders; the latest
 * one is always called.
 */
export function useLayer(active: boolean, onClose: () => void, opts: LayerOptions = {}): void {
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  const history = opts.history ?? false;
  const modal = opts.modal ?? false;
  useEffect(() => {
    if (!active) return undefined;
    return pushLayer(() => closeRef.current(), { history, modal });
  }, [active, history, modal]);
}

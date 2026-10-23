// Tiny global toast store, usable from React and from plain modules (e.g. the query client).

import { useSyncExternalStore } from 'react';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
  action?: ToastAction;
}

interface ToastOptions {
  kind?: ToastKind;
  action?: ToastAction;
  /** Auto-dismiss delay; errors stay a little longer by default. */
  durationMs?: number;
}

let toasts: Toast[] = [];
let nextId = 1;
const timers = new Map<number, number>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function arm(id: number, ms: number): void {
  window.clearTimeout(timers.get(id));
  timers.set(
    id,
    window.setTimeout(() => dismissToast(id), ms),
  );
}

export function toast(message: string, opts: ToastOptions = {}): number {
  const kind = opts.kind ?? 'info';
  const duration = opts.durationMs ?? (kind === 'error' || kind === 'warning' ? 7000 : 4500);
  // Same message already showing (e.g. repeated network errors): just extend it.
  const existing = toasts.find((t) => t.message === message && t.kind === kind && !t.action && !opts.action);
  if (existing) {
    arm(existing.id, duration);
    return existing.id;
  }
  const t: Toast = { id: nextId++, message, kind, action: opts.action };
  toasts = [...toasts.slice(-3), t]; // keep at most 4 on screen
  arm(t.id, duration);
  emit();
  return t.id;
}

export function dismissToast(id: number): void {
  window.clearTimeout(timers.get(id));
  timers.delete(id);
  const next = toasts.filter((t) => t.id !== id);
  if (next.length !== toasts.length) {
    toasts = next;
    emit();
  }
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, () => toasts);
}

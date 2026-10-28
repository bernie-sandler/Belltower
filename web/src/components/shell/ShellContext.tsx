import { createContext, useContext } from 'react';
import type { NewTicketMode, NewTicketPreset } from '../tickets/NewTicketDialog';

/** App-level actions reachable from anywhere (top bar menu, card detail, board). */
export interface ShellActions {
  openLabels: () => void;
  openSettings: () => void;
  /** Add ticket: Claude draft ('describe') or the empty form ('blank'). */
  openNewTicket: (mode: NewTicketMode, preset?: NewTicketPreset) => void;
  /** Add or change how a done card was resolved (e.g. from the toast after dragging into Done). */
  openResolution: (cardId: number) => void;
  /** Asks the board to open its "add column" form; the counter changes on each request. */
  requestAddColumn: () => void;
  addColumnRequest: number;
}

export const ShellContext = createContext<ShellActions | null>(null);

export function useShell(): ShellActions {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error('useShell must be used inside <AppShell>');
  return ctx;
}

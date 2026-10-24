// "261024-1 — Title": a card's ticket number shown in front of its title. The number is set when the
// card is created and never changes; the title stays editable on its own.

import type { ReactNode } from 'react';

/** The ticket number (when there is one), a dash, then `children` (the title, or a highlighted snippet of it). */
export function TicketTitle({ ticketNo, children }: { ticketNo: string | null; children: ReactNode }) {
  return (
    <>
      {ticketNo && (
        <>
          <span className="ticket-no">{ticketNo}</span>
          <span className="ticket-sep"> — </span>
        </>
      )}
      {children}
    </>
  );
}

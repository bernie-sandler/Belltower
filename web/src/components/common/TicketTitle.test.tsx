import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TicketTitle } from './TicketTitle';

describe('TicketTitle', () => {
  it('shows "number — title"', () => {
    const { container } = render(<TicketTitle ticketNo="261027-3">Fix fans</TicketTitle>);
    expect(container.textContent).toBe('261027-3 — Fix fans');
    expect(container.querySelector('.ticket-no')?.textContent).toBe('261027-3');
  });

  it('shows just the title without a number', () => {
    const { container } = render(<TicketTitle ticketNo={null}>Fix fans</TicketTitle>);
    expect(container.textContent).toBe('Fix fans');
  });
});

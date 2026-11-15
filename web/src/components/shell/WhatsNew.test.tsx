import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('virtual:latest-changelog', () => ({
  default: { version: '9.9.9', title: 'Shiny', body: '- **New thing.** It works.' },
}));

const { WhatsNew } = await import('./WhatsNew');

describe('WhatsNew', () => {
  beforeEach(() => localStorage.clear());

  it('only records the version on the first visit', () => {
    render(<WhatsNew appVersion="9.9.9" />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(localStorage.getItem('tt:last-seen-version')).toBe('9.9.9');
  });

  it('shows the newest notes once after an update', () => {
    localStorage.setItem('tt:last-seen-version', '9.9.8');
    const { unmount } = render(<WhatsNew appVersion="9.9.9" />);
    expect(screen.getByRole('dialog', { name: /What’s new in Belltower 9\.9\.9/ })).toBeTruthy();
    expect(screen.getByText('New thing.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(localStorage.getItem('tt:last-seen-version')).toBe('9.9.9');
    unmount();
    render(<WhatsNew appVersion="9.9.9" />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('can be turned off from the dialog', () => {
    localStorage.setItem('tt:last-seen-version', '9.9.8');
    render(<WhatsNew appVersion="9.9.9" />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show this after updates' }));
    expect(localStorage.getItem('tt:whats-new')).toBe('off');
  });
});

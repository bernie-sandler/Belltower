// @ autocomplete in the work-log field: what counts as an @ being typed, who matches, and picking
// with the keyboard or a tap without the card underneath closing.

import type { UserRef } from '@tt/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { matchPeople, mentionQueryAt, MentionTextarea } from './MentionTextarea';

const PEOPLE: UserRef[] = [
  { id: 1, username: 'admin', displayName: 'Admin', role: 'admin', disabled: false },
  { id: 2, username: 'jordan', displayName: 'Jordan Lee', role: 'member', disabled: false },
  { id: 3, username: 'alex', displayName: 'Alex Chen', role: 'admin', disabled: false },
  { id: 4, username: 'jo.old', displayName: 'Jo Former', role: 'member', disabled: true },
  { id: 5, username: 'lee', displayName: 'Sam Lee', role: 'member', disabled: false },
];

describe('mentionQueryAt', () => {
  it.each([
    ['@', 1, { start: 0, query: '' }],
    ['hi @jo', 6, { start: 3, query: 'jo' }],
    ['(@al', 4, { start: 1, query: 'al' }],
    ['line\n@ad', 8, { start: 5, query: 'ad' }],
    ['@jo and more', 3, { start: 0, query: 'jo' }],
    ['mail sam@ex', 11, null],
    ['see https://x.social/@jo', 24, null],
    ['run `ssh @jo', 12, null],
    ['done `code` @jo', 15, { start: 12, query: 'jo' }],
    ['hi @jo ', 7, null],
  ])('%j at %i', (text, caret, expected) => {
    expect(mentionQueryAt(text, caret)).toEqual(expected);
  });
});

describe('matchPeople', () => {
  it('matches usernames first, then a word of the name, and leaves out deactivated people', () => {
    expect(matchPeople(PEOPLE, 'le').map((p) => p.username)).toEqual(['lee', 'jordan']);
    expect(matchPeople(PEOPLE, 'jo').map((p) => p.username)).toEqual(['jordan']);
    expect(matchPeople(PEOPLE, 'CHEN').map((p) => p.username)).toEqual(['alex']);
    expect(matchPeople(PEOPLE, '').map((p) => p.username)).toEqual(['admin', 'jordan', 'alex', 'lee']);
    expect(matchPeople(PEOPLE, 'zz')).toEqual([]);
  });
});

function Harness({ onEscape }: { onEscape?: () => void }) {
  const [value, setValue] = useState('');
  return (
    // A stand-in for the card's global Esc handling: it only acts when nobody took the key.
    <div onKeyDown={(e) => e.key === 'Escape' && !e.defaultPrevented && onEscape?.()}>
      <MentionTextarea aria-label="Log work" value={value} onValueChange={setValue} people={PEOPLE} />
    </div>
  );
}

function typeInto(el: HTMLTextAreaElement, text: string) {
  fireEvent.change(el, { target: { value: text, selectionStart: text.length, selectionEnd: text.length } });
  el.setSelectionRange(text.length, text.length);
  fireEvent.select(el);
}

describe('MentionTextarea', () => {
  it('suggests people after @, moves with the arrow keys and picks with Enter', () => {
    render(<Harness />);
    const field = screen.getByLabelText('Log work') as HTMLTextAreaElement;
    typeInto(field, 'Thanks @j');
    const list = screen.getByRole('listbox', { name: 'People to mention' });
    expect(field.getAttribute('aria-controls')).toBe(list.id);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Jordan Lee@jordan']);
    typeInto(field, 'Thanks @');
    expect(screen.getAllByRole('option')).toHaveLength(4);
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    const active = screen.getAllByRole('option')[1]!;
    expect(active.getAttribute('aria-selected')).toBe('true');
    expect(field.getAttribute('aria-activedescendant')).toBe(active.id);
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(field.value).toBe('Thanks @jordan ');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Tab picks too, and ArrowUp wraps around', () => {
    render(<Harness />);
    const field = screen.getByLabelText('Log work') as HTMLTextAreaElement;
    typeInto(field, '@');
    fireEvent.keyDown(field, { key: 'ArrowUp' });
    fireEvent.keyDown(field, { key: 'Tab' });
    expect(field.value).toBe('@lee ');
  });

  it('a tap picks someone and keeps focus in the field', () => {
    render(<Harness />);
    const field = screen.getByLabelText('Log work') as HTMLTextAreaElement;
    field.focus();
    typeInto(field, 'cc @al');
    const option = screen.getByRole('option', { name: /Alex Chen/ });
    // pointerdown is cancelled, so the field never loses focus (and the phone keyboard stays up).
    expect(fireEvent.pointerDown(option)).toBe(false);
    fireEvent.click(option);
    expect(field.value).toBe('cc @alex ');
  });

  it('Esc closes the list without closing what’s underneath; the list stays shut for that word', () => {
    const onEscape = vi.fn();
    render(<Harness onEscape={onEscape} />);
    const field = screen.getByLabelText('Log work') as HTMLTextAreaElement;
    typeInto(field, 'hey @ad');
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onEscape).not.toHaveBeenCalled();
    typeInto(field, 'hey @adm');
    expect(screen.queryByRole('listbox')).toBeNull();
    // With nothing open, Esc is the card's again.
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(1);
    // A new @ opens it again.
    typeInto(field, 'hey @adm and @j');
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('Enter without a list is left to the field (and Ctrl+Enter to the composer)', () => {
    const onKeyDown = vi.fn();
    render(<MentionTextarea aria-label="Log work" value="no mention" onValueChange={() => undefined} people={PEOPLE} onKeyDown={onKeyDown} />);
    fireEvent.keyDown(screen.getByLabelText('Log work'), { key: 'Enter', ctrlKey: true });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });
});

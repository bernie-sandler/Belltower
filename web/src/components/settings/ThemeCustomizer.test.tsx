import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EMPTY_THEME, setCustomTheme } from '../../lib/customTheme';
import { ThemeCustomizer } from './ThemeCustomizer';

/** Types `text` one character at a time, the way a person does. */
function typeSlowly(input: HTMLElement, text: string) {
  for (let i = 1; i <= text.length; i++) fireEvent.change(input, { target: { value: text.slice(0, i) } });
}

const stored = () => JSON.parse(localStorage.getItem('tt:custom-theme') ?? 'null') as { dark: { colors: Record<string, string> } } | null;

describe('ThemeCustomizer color field', () => {
  afterEach(() => act(() => setCustomTheme(EMPTY_THEME)));

  it.each([
    ['#123456', '#123456'],
    ['aabbcc', '#aabbcc'],
    ['rgb(10, 20, 30)', '#0a141e'],
  ])('typing %j a key at a time ends at %s', (text, color) => {
    render(<ThemeCustomizer onClose={() => {}} />);
    const field = screen.getByRole('textbox', { name: 'Accent' });
    fireEvent.change(field, { target: { value: '' } });
    typeSlowly(field, text);
    expect(field).toHaveProperty('value', text);
    fireEvent.blur(field);
    expect(field).toHaveProperty('value', color);
    expect(stored()?.dark.colors.accent).toBe(color);
  });

  it('applies shorthand and bare "r g b" on Enter, not while typing', () => {
    render(<ThemeCustomizer onClose={() => {}} />);
    const field = screen.getByRole('textbox', { name: 'Accent' });
    fireEvent.change(field, { target: { value: '' } });
    typeSlowly(field, '#abc');
    expect(stored()).toBeNull();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(stored()?.dark.colors.accent).toBe('#aabbcc');
  });

  it('marks text that is not a color and keeps the old one', () => {
    render(<ThemeCustomizer onClose={() => {}} />);
    const field = screen.getByRole('textbox', { name: 'Accent' });
    fireEvent.change(field, { target: { value: 'blurple' } });
    fireEvent.blur(field);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(stored()).toBeNull();
  });
});

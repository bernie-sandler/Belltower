import { describe, expect, it } from 'vitest';
import { contrast, mix, parseColor, readableOn, rgbText, withAlpha } from './colors';

describe('parseColor', () => {
  it.each([
    ['#E2A64B', '#e2a64b'],
    ['e2a64b', '#e2a64b'],
    ['#abc', '#aabbcc'],
    ['  #ABC  ', '#aabbcc'],
    ['rgb(226, 166, 75)', '#e2a64b'],
    ['rgb(226 166 75)', '#e2a64b'],
    ['226, 166, 75', '#e2a64b'],
  ])('%s → %s', (input, out) => {
    expect(parseColor(input)).toBe(out);
  });

  it.each(['', '#12', '#abcd', '#1234567', 'rgb(256, 0, 0)', 'rgba(1, 2, 3, 0.5)', 'rgb(1, 2, 3', 'red', '1, 2'])('rejects %j', (input) => {
    expect(parseColor(input)).toBeNull();
  });
});

describe('color math', () => {
  it('mixes, adds alpha and prints rgb()', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mix('#123456', '#ffffff', 0)).toBe('#123456');
    expect(withAlpha('#e2a64b', 0.3)).toBe('rgba(226, 166, 75, 0.3)');
    expect(rgbText('#e2a64b')).toBe('rgb(226, 166, 75)');
  });

  it('measures WCAG contrast', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#777777')).toBeCloseTo(1, 5);
  });

  it('nudges a color until it is readable', () => {
    const c = readableOn('#579dff', ['#ffffff', '#f7f8f9'], 4.5, 'black');
    expect(contrast(c, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(readableOn('#000000', ['#ffffff'], 4.5, 'black')).toBe('#000000');
  });
});

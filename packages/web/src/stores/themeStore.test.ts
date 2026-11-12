import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, normalizeMsnFrames, normalizeTheme } from './themeStore';

describe('normalizeTheme', () => {
  it.each(['aether-drift', 'oled', 'anime', 'msn', 'msn-dark'])('keeps %s', id => {
    expect(normalizeTheme(id)).toBe(id);
  });

  it.each([undefined, null, 3, 'neon', ''])('falls back for %s', value => {
    expect(normalizeTheme(value)).toBe(DEFAULT_THEME);
  });
});

describe('normalizeMsnFrames', () => {
  it.each([true, false])('keeps %s', value => {
    expect(normalizeMsnFrames(value)).toBe(value);
  });

  it.each([undefined, null, 'no', 0])('falls back to on for %s', value => {
    expect(normalizeMsnFrames(value)).toBe(true);
  });
});

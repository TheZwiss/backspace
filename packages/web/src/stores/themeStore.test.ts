import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, normalizeTheme } from './themeStore';

describe('normalizeTheme', () => {
  it.each(['aether-drift', 'oled', 'anime'])('keeps %s', id => {
    expect(normalizeTheme(id)).toBe(id);
  });

  it.each([undefined, null, 3, 'neon', ''])('falls back for %s', value => {
    expect(normalizeTheme(value)).toBe(DEFAULT_THEME);
  });
});

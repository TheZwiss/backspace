import { describe, it, expect } from 'vitest';
import { pickLanguage, resolveSupportedLanguage, supportedLanguages } from './languages';

describe('resolveSupportedLanguage', () => {
  it('maps a regional tag to its base language when that base is shipped', () => {
    expect(resolveSupportedLanguage('ru-RU')).toBe('ru');
    expect(resolveSupportedLanguage('de-CH')).toBe('de');
  });

  it('is case-insensitive', () => {
    expect(resolveSupportedLanguage('EN-us')).toBe('en');
  });

  it('returns null for a language that is not shipped', () => {
    expect(resolveSupportedLanguage('fr')).toBeNull();
    expect(resolveSupportedLanguage('')).toBeNull();
  });
});

describe('pickLanguage', () => {
  it('prefers the stored choice over the browser languages', () => {
    expect(pickLanguage('de', ['ru-RU'])).toBe('de');
  });

  it('ignores a stored value that is not a shipped language', () => {
    expect(pickLanguage('fr', ['ru-RU'])).toBe('ru');
  });

  it('takes the first browser language that is shipped, in order', () => {
    expect(pickLanguage(null, ['fr-FR', 'de-DE', 'ru'])).toBe('de');
  });

  it('falls back to English when nothing matches', () => {
    expect(pickLanguage(null, ['fr-FR', 'ja'])).toBe('en');
    expect(pickLanguage(null, [])).toBe('en');
  });
});

describe('supportedLanguages', () => {
  it('lists every language by its own name and text direction', () => {
    expect(supportedLanguages.map((l) => l.code)).toEqual(['en', 'ru', 'de']);
    for (const language of supportedLanguages) {
      expect(language.nativeName.length).toBeGreaterThan(0);
      expect(['ltr', 'rtl']).toContain(language.dir);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { availableLanguages, isSupportedLanguage, pickLanguage, readPreviewLanguage, resolveSupportedLanguage, supportedLanguages } from './languages';

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
  const allReleased = new Set(['en', 'ru', 'de']);

  it('prefers the stored choice over the browser languages', () => {
    expect(pickLanguage('de', ['ru-RU'], allReleased)).toBe('de');
  });

  it('ignores a stored value that is not a shipped language', () => {
    expect(pickLanguage('fr', ['ru-RU'], allReleased)).toBe('ru');
  });

  it('takes the first browser language that is shipped, in order', () => {
    expect(pickLanguage(null, ['fr-FR', 'de-DE', 'ru'], allReleased)).toBe('de');
  });

  it('falls back to English when nothing matches', () => {
    expect(pickLanguage(null, ['fr-FR', 'ja'])).toBe('en');
    expect(pickLanguage(null, [])).toBe('en');
  });
});

describe('availableLanguages', () => {
  it('offers every released language to users', () => {
    // English, Russian and German all ship since 1.1.0.
    expect(availableLanguages.map((l) => l.code)).toEqual(['en', 'ru', 'de']);
  });

  it('never lets detection pick a language that is not released', () => {
    // The gate stays in place for the next language; exercise it with an
    // explicit released set so the test does not depend on the shipped flags.
    const englishOnly = new Set(['en']);
    expect(pickLanguage('ru', ['ru-RU'], englishOnly)).toBe('en');
    expect(pickLanguage(null, ['de-DE'], englishOnly)).toBe('en');
  });

  it('lets detection pick a released language', () => {
    expect(pickLanguage('ru', ['en'])).toBe('ru');
    expect(pickLanguage(null, ['de-DE'])).toBe('de');
  });

  it('still lets code select any supported language explicitly', () => {
    expect(isSupportedLanguage('ru')).toBe(true);
    expect(resolveSupportedLanguage('de-CH')).toBe('de');
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

describe('readPreviewLanguage', () => {
  it('reads ?lang= in development so unreleased languages can be reviewed', () => {
    expect(readPreviewLanguage('?lang=de', true)).toBe('de');
    expect(readPreviewLanguage('?foo=1&lang=ru-RU', true)).toBe('ru');
  });

  it('ignores the parameter in production builds', () => {
    expect(readPreviewLanguage('?lang=de', false)).toBeNull();
  });

  it('ignores values that are not shipped languages', () => {
    expect(readPreviewLanguage('?lang=fr', true)).toBeNull();
    expect(readPreviewLanguage('', true)).toBeNull();
  });
});

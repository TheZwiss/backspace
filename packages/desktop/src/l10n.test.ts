import { describe, it, expect } from 'vitest';
import {
  DESKTOP_CATALOGS,
  resolveDesktopLanguage,
  translateDesktop,
  type DesktopLanguage,
} from './l10n';

// The module reads nothing from Electron at import time on purpose: the
// language is passed in, so the strings are testable in plain Node.

describe('resolveDesktopLanguage', () => {
  it('prefers the language the renderer reported', () => {
    expect(resolveDesktopLanguage('ru', 'de-DE')).toBe('ru');
  });

  it('falls back to the OS locale mapped to its base language', () => {
    expect(resolveDesktopLanguage(null, 'de-AT')).toBe('de');
    expect(resolveDesktopLanguage('nonsense', 'ru-RU')).toBe('ru');
  });

  it('falls back to English when neither is shipped', () => {
    expect(resolveDesktopLanguage(null, 'fr-FR')).toBe('en');
    expect(resolveDesktopLanguage(null, '')).toBe('en');
  });
});

describe('translateDesktop', () => {
  it('returns the string for the language', () => {
    expect(translateDesktop('en', 'tray.show')).toBe('Show Backspace');
    expect(translateDesktop('ru', 'tray.show')).toBe('Показать Backspace');
    expect(translateDesktop('de', 'tray.show')).toBe('Backspace anzeigen');
  });

  it('interpolates a version into the download item', () => {
    expect(translateDesktop('en', 'update.downloadVersion', { version: '1.2.3' })).toBe('Download Backspace 1.2.3…');
    expect(translateDesktop('de', 'update.downloadVersion', { version: '1.2.3' })).toBe('Backspace 1.2.3 herunterladen…');
  });
});

describe('DESKTOP_CATALOGS', () => {
  it('has every English key in every other language, and nothing extra', () => {
    const english = Object.keys(DESKTOP_CATALOGS.en).sort();
    for (const language of Object.keys(DESKTOP_CATALOGS) as DesktopLanguage[]) {
      expect(Object.keys(DESKTOP_CATALOGS[language]).sort(), language).toEqual(english);
    }
  });

  it('uses the same placeholders in every language', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(DESKTOP_CATALOGS.en) as (keyof typeof DESKTOP_CATALOGS.en)[]) {
      const expected = placeholders(DESKTOP_CATALOGS.en[key]);
      for (const language of Object.keys(DESKTOP_CATALOGS) as DesktopLanguage[]) {
        expect(placeholders(DESKTOP_CATALOGS[language][key]), `${language}:${key}`).toEqual(expected);
      }
    }
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import i18n, { LANGUAGE_STORAGE_KEY, resolvePreferredLanguage } from './i18n';

describe('i18n', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
    localStorage.removeItem(LANGUAGE_STORAGE_KEY);
  });

  it('switches to Russian and persists the choice', async () => {
    await i18n.changeLanguage('ru');

    expect(i18n.t('common.settings')).toBe('Настройки');
    expect(document.documentElement.lang).toBe('ru');
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('ru');
  });

  it.each([
    ['de', 'Einstellungen'],
    ['es', 'Configuración'],
  ])('switches to %s and persists the choice', async (language, settings) => {
    await i18n.changeLanguage(language);

    expect(i18n.t('common.settings')).toBe(settings);
    expect(document.documentElement.lang).toBe(language);
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe(language);
  });

  it('falls back to English for unsupported languages', async () => {
    await i18n.changeLanguage('fr');

    expect(i18n.t('common.settings')).toBe('Settings');
    expect(document.documentElement.lang).toBe('en');
  });

  it('uses the first supported browser preference including regional variants', () => {
    expect(resolvePreferredLanguage(['fr-FR', 'es-MX', 'de-DE'])).toBe('es');
    expect(resolvePreferredLanguage(['de-AT', 'es-ES'])).toBe('de');
    expect(resolvePreferredLanguage(['fr-FR', 'it-IT'])).toBe('en');
  });
});

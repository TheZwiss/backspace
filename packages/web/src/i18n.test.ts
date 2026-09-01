import { afterEach, describe, expect, it } from 'vitest';
import i18n, { LANGUAGE_STORAGE_KEY } from './i18n';

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

  it('falls back to English for unsupported languages', async () => {
    await i18n.changeLanguage('de');

    expect(i18n.t('common.settings')).toBe('Settings');
    expect(document.documentElement.lang).toBe('en');
  });
});

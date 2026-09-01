import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en/translation.json';
import ru from './locales/ru/translation.json';

export const LANGUAGE_STORAGE_KEY = 'backspace-language';

export const supportedLanguages = [
  { code: 'en', nativeName: 'English' },
  { code: 'ru', nativeName: 'Русский' },
] as const;

export type SupportedLanguage = (typeof supportedLanguages)[number]['code'];

export function isSupportedLanguage(value: string | null): value is SupportedLanguage {
  return supportedLanguages.some(({ code }) => code === value);
}

export function resolveSupportedLanguage(value: string): SupportedLanguage {
  const baseLanguage = value.toLowerCase().split('-')[0] ?? '';
  return isSupportedLanguage(baseLanguage) ? baseLanguage : 'en';
}

function detectLanguage(): SupportedLanguage {
  if (typeof window === 'undefined') return 'en';

  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  } catch {
    // Storage may be disabled by browser privacy settings.
  }
  if (isSupportedLanguage(stored)) return stored;

  const browserLanguages = navigator.languages?.length ? navigator.languages : [navigator.language];
  return browserLanguages.some((language) => language.toLowerCase().startsWith('ru')) ? 'ru' : 'en';
}

void i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      ru: { translation: ru },
    },
    lng: detectLanguage(),
    fallbackLng: 'en',
    supportedLngs: supportedLanguages.map(({ code }) => code),
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });

function applyDocumentLanguage(language: string) {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = isSupportedLanguage(language) ? language : 'en';
}

applyDocumentLanguage(i18n.resolvedLanguage ?? i18n.language);
i18n.on('languageChanged', (language) => {
  if (isSupportedLanguage(language) && typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    } catch {
      // The in-memory selection still works when persistence is unavailable.
    }
  }
  applyDocumentLanguage(language);
});

export default i18n;

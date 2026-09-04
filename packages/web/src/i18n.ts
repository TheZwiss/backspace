import i18n, { type BackendModule } from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en/translation.json';

export const LANGUAGE_STORAGE_KEY = 'backspace-language';

export const supportedLanguages = [
  { code: 'en', nativeName: 'English' },
  { code: 'de', nativeName: 'Deutsch' },
  { code: 'es', nativeName: 'Español' },
  { code: 'ru', nativeName: 'Русский' },
] as const;

export type SupportedLanguage = (typeof supportedLanguages)[number]['code'];

const localeLoaders = {
  de: () => import('./locales/de/translation.json'),
  es: () => import('./locales/es/translation.json'),
  ru: () => import('./locales/ru/translation.json'),
};

const translationBackend: BackendModule = {
  type: 'backend',
  init: () => {},
  read(language, _namespace, callback) {
    if (!isSupportedLanguage(language)) {
      callback(new Error(`Unsupported language: ${language}`), null);
      return;
    }
    if (language === 'en') {
      callback(null, en);
      return;
    }
    localeLoaders[language]()
      .then(({ default: catalog }) => callback(null, catalog))
      .catch((error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), null));
  },
};

export function translate(key: string, options?: Record<string, unknown>): string {
  return i18n.t(key, options);
}

export function isSupportedLanguage(value: string | null): value is SupportedLanguage {
  return supportedLanguages.some(({ code }) => code === value);
}

export function resolveSupportedLanguage(value: string): SupportedLanguage {
  const baseLanguage = value.toLowerCase().split('-')[0] ?? '';
  return isSupportedLanguage(baseLanguage) ? baseLanguage : 'en';
}

export function resolvePreferredLanguage(values: readonly string[]): SupportedLanguage {
  for (const value of values) {
    const baseLanguage = value.toLowerCase().split('-')[0] ?? '';
    if (isSupportedLanguage(baseLanguage)) return baseLanguage;
  }
  return 'en';
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
  return resolvePreferredLanguage(browserLanguages);
}

void i18n
  .use(translationBackend)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
    },
    partialBundledLanguages: true,
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

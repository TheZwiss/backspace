import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { LazyCatalogBackend } from './loader';
import { defaultNS, namespaces, resources } from './resources';
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_STORAGE_KEY,
  getLanguageDirection,
  isSupportedLanguage,
  pickLanguage,
  supportedLanguageCodes,
  type SupportedLanguage,
} from './languages';

export { LANGUAGE_STORAGE_KEY, supportedLanguages, type SupportedLanguage } from './languages';

const i18n = i18next;

function readStoredLanguage(): string | null {
  try {
    return window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  } catch {
    // Storage can be disabled by browser privacy settings; detection continues without it.
    return null;
  }
}

function writeStoredLanguage(language: SupportedLanguage): void {
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // The in-memory selection still applies for this session.
  }
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  if (navigator.languages && navigator.languages.length > 0) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}

function applyDocumentLanguage(language: SupportedLanguage): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = language;
  document.documentElement.dir = getLanguageDirection(language);
}

function notifyDesktop(language: SupportedLanguage): void {
  if (typeof window === 'undefined') return;
  window.backspace?.setLanguage?.(language);
}

export interface InitI18nOptions {
  /** Overrides `navigator.languages`; used by tests and by the desktop shell. */
  browserLanguages?: readonly string[];
}

/**
 * Initialise i18next in the detected language and resolve once that
 * language's catalogs are loaded, so the first render is already
 * translated. Safe to call more than once: later calls only re-run detection.
 */
export async function initI18n(options: InitI18nOptions = {}): Promise<typeof i18n> {
  const language = pickLanguage(readStoredLanguage(), options.browserLanguages ?? browserLanguages());

  if (i18n.isInitialized) {
    await i18n.changeLanguage(language);
  } else {
    await i18n
      .use(LazyCatalogBackend)
      .use(initReactI18next)
      .init({
        lng: language,
        fallbackLng: DEFAULT_LANGUAGE,
        supportedLngs: [...supportedLanguageCodes],
        load: 'languageOnly',
        defaultNS,
        ns: namespaces,
        resources,
        partialBundledLanguages: true,
        returnNull: false,
        interpolation: { escapeValue: false },
        react: { useSuspense: false },
      });
  }

  applyDocumentLanguage(language);
  notifyDesktop(language);
  return i18n;
}

/** The user picked a language in settings: switch, remember, and tell the desktop shell. */
export async function setLanguage(language: SupportedLanguage): Promise<void> {
  if (!isSupportedLanguage(language)) return;
  await i18n.changeLanguage(language);
  writeStoredLanguage(language);
  applyDocumentLanguage(language);
  notifyDesktop(language);
}

export function getLanguage(): SupportedLanguage {
  const current = i18n.resolvedLanguage ?? i18n.language;
  return isSupportedLanguage(current) ? current : DEFAULT_LANGUAGE;
}

export default i18n;

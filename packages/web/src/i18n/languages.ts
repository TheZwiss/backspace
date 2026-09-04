/**
 * The languages Backspace ships, and how a browser or stored preference is
 * mapped onto them. Adding a language is one entry here plus its catalogs
 * under `src/locales/<code>/`; see docs/systems/localization.md.
 */
export const supportedLanguages = [
  { code: 'en', nativeName: 'English', dir: 'ltr', released: true },
  // Russian and German are complete in code and tests but stay hidden from
  // users until every surface is translated (the 1.1.0 gate), so a release
  // cut in between is English-only rather than half translated. Flip
  // `released` in the PR that empties scripts/i18n-pending.txt.
  { code: 'ru', nativeName: 'Русский', dir: 'ltr', released: false },
  { code: 'de', nativeName: 'Deutsch', dir: 'ltr', released: false },
] as const satisfies readonly { code: string; nativeName: string; dir: 'ltr' | 'rtl'; released: boolean }[];

export type SupportedLanguage = (typeof supportedLanguages)[number]['code'];

export const DEFAULT_LANGUAGE: SupportedLanguage = 'en';

/** Kept from the community translation in PR #45 so its testers keep their choice. */
export const LANGUAGE_STORAGE_KEY = 'backspace-language';

export const supportedLanguageCodes: readonly SupportedLanguage[] = supportedLanguages.map((l) => l.code);

/** The languages users can pick and detection may choose. */
export const availableLanguages = supportedLanguages.filter((l) => l.released);

const releasedLanguageCodes: ReadonlySet<string> = new Set(availableLanguages.map((l) => l.code));

export function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return typeof value === 'string' && (supportedLanguageCodes as readonly string[]).includes(value);
}

/**
 * Map a BCP 47 tag such as `de-CH` onto a shipped language, or null when the
 * base language is not shipped. Regional variants are not distinguished: a
 * Swiss German user gets German.
 */
export function resolveSupportedLanguage(tag: string): SupportedLanguage | null {
  const base = tag.trim().toLowerCase().split('-')[0] ?? '';
  return isSupportedLanguage(base) ? base : null;
}

/**
 * Detection order: the stored choice, then the browser's languages in the
 * order the user ranked them, then English. Only released languages are
 * eligible; `released` exists so tests can exercise the others.
 */
export function pickLanguage(
  stored: string | null,
  browserLanguages: readonly string[],
  released: ReadonlySet<string> = releasedLanguageCodes,
): SupportedLanguage {
  if (isSupportedLanguage(stored) && released.has(stored)) return stored;
  for (const tag of browserLanguages) {
    const match = resolveSupportedLanguage(tag);
    if (match && released.has(match)) return match;
  }
  return DEFAULT_LANGUAGE;
}

export function getLanguageDirection(language: SupportedLanguage): 'ltr' | 'rtl' {
  return supportedLanguages.find((l) => l.code === language)?.dir ?? 'ltr';
}

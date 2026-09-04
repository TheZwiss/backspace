/**
 * The few strings the main process shows on its own: tray and application
 * menu items, update actions, and the recovery and instance-picker pages.
 *
 * The renderer owns the language choice and reports it over the
 * `set-language` IPC channel; main remembers it in userData so the tray is
 * right from the first paint on the next launch. Before the renderer has
 * ever said anything, the OS locale decides.
 *
 * This is deliberately not i18next: the main process has under thirty
 * strings and no React, and pulling the library into the Electron bundle
 * for that would be weight without benefit. Keys mirror the web's
 * `desktop` namespace conventions so the two are easy to compare.
 */
import { app } from 'electron';
import fs from 'fs';
import path from 'path';

export type DesktopLanguage = 'en' | 'ru' | 'de';

const DESKTOP_LANGUAGES: readonly DesktopLanguage[] = ['en', 'ru', 'de'];

const en = {
  'tray.show': 'Show Backspace',
  'tray.hide': 'Hide',
  'tray.changeInstance': 'Change Instance',
  'tray.sourceCode': 'Source code (AGPL)',
  'tray.quit': 'Quit',
  'menu.edit': 'Edit',
  'menu.window': 'Window',
  'update.check': 'Check for Updates…',
  'update.checkAfterFailure': 'Check for Updates… (last attempt failed)',
  'update.checking': 'Checking for Updates…',
  'update.downloading': 'Downloading Update…',
  'update.ready': 'Update Ready',
  'update.available': 'Update Available',
  'update.restartToInstall': 'Restart to Install Update',
  'update.downloadVersion': 'Download Backspace {version}…',
  'update.download': 'Download the Update…',
} as const;

export type DesktopStringKey = keyof typeof en;

type Catalog = Record<DesktopStringKey, string>;

const ru: Catalog = {
  'tray.show': 'Показать Backspace',
  'tray.hide': 'Скрыть',
  'tray.changeInstance': 'Сменить сервер',
  'tray.sourceCode': 'Исходный код (AGPL)',
  'tray.quit': 'Выйти',
  'menu.edit': 'Правка',
  'menu.window': 'Окно',
  'update.check': 'Проверить обновления…',
  'update.checkAfterFailure': 'Проверить обновления… (последняя попытка не удалась)',
  'update.checking': 'Проверка обновлений…',
  'update.downloading': 'Загрузка обновления…',
  'update.ready': 'Обновление готово',
  'update.available': 'Доступно обновление',
  'update.restartToInstall': 'Перезапустить для установки',
  'update.downloadVersion': 'Скачать Backspace {version}…',
  'update.download': 'Скачать обновление…',
};

const de: Catalog = {
  'tray.show': 'Backspace anzeigen',
  'tray.hide': 'Ausblenden',
  'tray.changeInstance': 'Instanz wechseln',
  'tray.sourceCode': 'Quellcode (AGPL)',
  'tray.quit': 'Beenden',
  'menu.edit': 'Bearbeiten',
  'menu.window': 'Fenster',
  'update.check': 'Nach Updates suchen…',
  'update.checkAfterFailure': 'Nach Updates suchen… (letzter Versuch fehlgeschlagen)',
  'update.checking': 'Suche nach Updates…',
  'update.downloading': 'Update wird heruntergeladen…',
  'update.ready': 'Update bereit',
  'update.available': 'Update verfügbar',
  'update.restartToInstall': 'Neu starten und Update installieren',
  'update.downloadVersion': 'Backspace {version} herunterladen…',
  'update.download': 'Update herunterladen…',
};

export const DESKTOP_CATALOGS: Record<DesktopLanguage, Catalog> = { en, ru, de };

export function isDesktopLanguage(value: unknown): value is DesktopLanguage {
  return typeof value === 'string' && (DESKTOP_LANGUAGES as readonly string[]).includes(value);
}

/** `de-AT` → `de`; anything not shipped → null. Same rule as the web client. */
function baseLanguage(tag: string): DesktopLanguage | null {
  const base = tag.trim().toLowerCase().split('-')[0] ?? '';
  return isDesktopLanguage(base) ? base : null;
}

/**
 * Stored renderer choice first, then the OS locale, then English.
 */
export function resolveDesktopLanguage(stored: string | null, appLocale: string): DesktopLanguage {
  if (isDesktopLanguage(stored)) return stored;
  return baseLanguage(appLocale) ?? 'en';
}

export function translateDesktop(
  language: DesktopLanguage,
  key: DesktopStringKey,
  values?: Record<string, string>,
): string {
  const text = DESKTOP_CATALOGS[language][key];
  if (!values) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}

// ---------------------------------------------------------------------------
// Persistence: one JSON file next to instance-url.json.
// ---------------------------------------------------------------------------

export function getLanguagePath(): string {
  return path.join(app.getPath('userData'), 'language.json');
}

export function loadStoredLanguage(): DesktopLanguage | null {
  try {
    const data = JSON.parse(fs.readFileSync(getLanguagePath(), 'utf-8')) as { language?: unknown };
    return isDesktopLanguage(data.language) ? data.language : null;
  } catch {
    return null;
  }
}

export function saveStoredLanguage(language: DesktopLanguage): void {
  fs.writeFileSync(getLanguagePath(), JSON.stringify({ language }));
}

/** The language for the current process: stored choice, else OS locale, else English. */
export function getDesktopLanguage(): DesktopLanguage {
  return resolveDesktopLanguage(loadStoredLanguage(), app.getLocale());
}

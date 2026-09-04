# Localization

The web and desktop interfaces use `i18next` with the React integration. English
is the source and fallback language. German, Spanish, and Russian ship as
complete additional locales.

## Structure

- `packages/web/src/i18n.ts` owns initialization, language detection, persistence,
  supported-language metadata, catalog loading, and the document `lang`
  attribute. English is bundled as the immediate fallback; every additional
  locale is a lazy-loaded chunk, so adding a language does not inflate the
  initial application bundle.
- `packages/web/src/locales/<language>/translation.json` contains translations.
- UI components read strings with `useTranslation()`, `<Trans>`, or the shared
  `translate()` helper. Keys are stable and scoped by surface, for example
  `common.settings`, `auth.usernameRequired`, or `ui.MessageList.leaveGroup`.

The selected language is stored locally under `backspace-language`. On a new
installation, the first supported preference from the browser's language list
is selected automatically, including regional variants such as `de-AT`,
`es-MX`, and `ru-RU`. If none is supported, the interface uses English. Missing
translations fall back to English.

## Adding a language

1. Copy `packages/web/src/locales/en/translation.json` to a new locale directory
   and translate values without changing keys or `{{interpolation}}` variables.
2. Import the file in `packages/web/src/i18n.ts`, add its resources, and append its
   language code and native name to `supportedLanguages`.
3. Run `pnpm --filter @backspace/web check:i18n`,
   `pnpm --filter @backspace/web typecheck`, and
   `pnpm --filter @backspace/web test`.
4. Check authentication, settings, dialogs, and mobile navigation at narrow and
   desktop widths. Verify long labels wrap without clipping.

New user-facing copy on localized surfaces must be added to the English catalog
and every shipped locale in the same change. Do not translate user content,
server-provided names, protocol values, log messages, or accessibility-hidden
implementation details.

The i18n check discovers every shipped locale, compares its catalog structure
and interpolation placeholders with English, rejects untranslated entries
(apart from an explicit brand/technical allowlist), and detects common
hard-coded UI text patterns. It runs automatically during the web typecheck and
production build.

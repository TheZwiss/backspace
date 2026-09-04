# Localization

How Backspace is translated, and the rules every string, count, date and
error message follows so that the translations stay correct as the product
moves. This spec is the contract; the foundation PR implements it and each
surface sweep PR extends it.

Shipped languages: English (`en`, the source language and the fallback),
Russian (`ru`), German (`de`). Adding a language is a catalog directory plus
one entry in `supportedLanguages`; nothing else in the code should need to
know the list.

Source files:
- Runtime setup: `packages/web/src/i18n/index.ts` (`initI18n`, `setLanguage`,
  `getLanguage`; detection, persistence, `<html lang>`/`dir` sync, desktop IPC)
- Language list: `packages/web/src/i18n/languages.ts` (`supportedLanguages`,
  `SupportedLanguage`, `resolveSupportedLanguage`, `pickLanguage`)
- Lazy catalog loader: `packages/web/src/i18n/loader.ts` (`LazyCatalogBackend`)
- Typed keys: `packages/web/src/i18n/resources.ts` and
  `packages/web/src/i18n/i18next.d.ts` (`CustomTypeOptions`)
- Formatters: `packages/web/src/i18n/formatters.ts` (`createFormatters`,
  `formatters`, `useFormatters`)
- Error mapping: `packages/web/src/i18n/errors.ts` (`describeError`)
- Language picker: `packages/web/src/components/modals/settingsPanels/LanguageSection.tsx`
- Catalogs: `packages/web/src/locales/<lng>/<namespace>.json`
- Shared error codes: `packages/shared/src/errors.ts` (`ERROR_CODES`,
  `ErrorCode`, `ApiErrorBody`, `isErrorCode`)
- Server error helper: `packages/server/src/utils/httpErrors.ts` (`sendError`,
  `ERROR_MESSAGES`)
- Desktop main-process catalog: `packages/desktop/src/l10n.ts`; the recovery
  and instance-picker pages under `packages/desktop/resources/` carry their
  own inline catalogs
- Consistency check: `scripts/check-i18n.mjs` with its rules in
  `scripts/i18n/check.mjs` (runs in `pnpm typecheck` and in the web build)
- Test bootstrap: `packages/web/src/test/setup.ts` starts i18next in English
  before any component test renders

---

## Library

`i18next` with `react-i18next`. Chosen because the catalogs are plain JSON
that Weblate, Crowdin and every other translation tool can read, and because
its plural handling uses the CLDR categories (`one`, `few`, `many`, `other`)
that Russian needs. No ICU message-format plugin: interpolation plus CLDR
plurals cover everything the UI says, and ICU syntax in catalogs is a
translator hazard.

No other dependency. Dates, numbers and relative times come from the
platform `Intl` APIs.

---

## Keys

Keys name what a string means in the product, never what it says in English
and never where it lives in the source tree.

Shape: `<namespace>:<element>.<meaning>`, for example
`chat:composer.placeholder`, `settings:desktop.autoLaunch.label`,
`voice:controls.mute`, `errors:auth.invalidCredentials`.

Rules:
- The namespace is a product surface (table below), not a component or file
  name. Renaming a component never touches a catalog.
- Segments are camelCase, no spaces, no sentence text. A key like
  `yourPasswordIsVerifiedLocally` is wrong; `passwordLocalVerificationNote`
  is right.
- One key per distinct meaning. Two places that happen to say "Save" but
  mean different actions (save a draft, save profile changes) get two keys;
  translators may need different words.
- Never build a key at runtime from a variable (`t(\`status.${x}\`)`) unless
  the variable is a closed union and every member is listed in the catalog.
  The check script cannot see through it, so the call site names the keys it
  covers in a comment for the check script (see Consistency check).
- Keys are typed. `t('chat:composer.placeholde')` is a compile error and
  keys autocomplete in the editor. A component that mixes namespaces declares
  them both: `useTranslation(['settings', 'common'])`, then
  `t('common:actions.save')`. With only `useTranslation('settings')` the
  `common:` prefix is a type error, which is i18next 26 doing its job.

### Namespaces

| Namespace | Covers |
|-----------|--------|
| `common` | Shared verbs and nouns used across surfaces: Save, Cancel, Close, Delete, Copy, Loading, Yes, No, Unknown; the language selector |
| `auth` | Login, register, join-by-invite, password fields, federated account creation |
| `chat` | Message list, composer, attachments, embeds, reactions, replies, typing, jump-to-message |
| `dm` | DM list, group DM management, DM calls, DM system messages |
| `voice` | Voice channel controls, screen share, stream tiles, device pickers |
| `spaces` | Space, category and channel CRUD, invites, discovery, membership, bans, roles |
| `settings` | User settings modal and its panels (account, voice, privacy, connections, keybinds, desktop) |
| `admin` | Instance settings panels (general, registration, users, storage, streaming, updates, federation) |
| `federation` | Connected instances UI, peering requests, identity attach and detach |
| `social` | Friends page, friend requests, user profiles, mutuals, user search |
| `search` | Search popover and filter help |
| `uploads` | Transfer indicator, upload errors, crop dialog |
| `desktop` | Renderer-side desktop strings: update banner, recovery notices, keybind setup |
| `mobile` | Mobile shell, bottom navigation, screen titles |
| `errors` | Localized messages for every `ErrorCode` in `packages/shared` |

One JSON file per namespace per language. `common` is the default
namespace; everything else is referenced with the `ns:` prefix.

---

## Plurals

Every string that contains a count goes through an i18next plural key. No
`${n} file${n === 1 ? '' : 's'}`, no `_one`/`_other` suffix tricks that leave
the noun outside the catalog.

Each language supplies the CLDR categories it needs:

| Language | Categories |
|----------|-----------|
| en | `_one`, `_other` |
| de | `_one`, `_other` |
| ru | `_one`, `_few`, `_many`, `_other` |

Example (`admin.json`):

```json
{
  "storage": {
    "deletedFiles_one": "Deleted {{count}} file",
    "deletedFiles_other": "Deleted {{count}} files"
  }
}
```

Russian:

```json
{
  "storage": {
    "deletedFiles_one": "Удалён {{count}} файл",
    "deletedFiles_few": "Удалено {{count}} файла",
    "deletedFiles_many": "Удалено {{count}} файлов",
    "deletedFiles_other": "Удалено {{count}} файла"
  }
}
```

The check script fails a catalog whose plural key is missing a category for
its language, and fails any `t()` call that interpolates `count` into a key
without plural forms.

Zero is a normal `_other` (or `_many` in Russian) unless the UI wants a
distinct phrase, in which case the key gets a `_zero` form and the call site
passes `count: 0` as usual.

---

## Dates, times and numbers

All formatting goes through `packages/web/src/i18n/formatters.ts`. Nothing
else in the web package calls `toLocaleDateString`, `toLocaleTimeString`,
`toLocaleString` or constructs an `Intl.*` formatter directly; the check
script enforces this.

The formatters take the locale from the selected language, not from the
browser default, so a German user on an English OS sees German dates. Each
formatter reads `i18n.resolvedLanguage` at call time; components use the
`useFormatters()` hook, which subscribes to language changes and re-renders.

| Function | Use | Backing API |
|----------|-----|-------------|
| `formatTime(ts)` | Message timestamps, "today" DM previews | `Intl.DateTimeFormat` `{ hour: 'numeric', minute: '2-digit' }` |
| `formatShortDate(ts)` | DM previews, day separators | `{ month: 'short', day: 'numeric' }`, year added when not the current year |
| `formatMediumDate(ts)` | Lists that always want the year: users, bans, peers, profile "member since" | `{ month: 'short', day: 'numeric', year: 'numeric' }` |
| `formatLongDate(ts)` | Update panel | `{ day: 'numeric', month: 'long', year: 'numeric' }` |
| `formatFullDate(ts)` | Message list day separators | weekday plus long date |
| `formatNumericDate(ts)` | Compact tables | `{ dateStyle: 'short' }` |
| `formatDateTime(ts)` | Message hover, search results, redemption log | `{ dateStyle: 'medium', timeStyle: 'short' }` |
| `formatRelativeTime(ts)` | "Last checked 5 minutes ago": elapsed time in the largest whole unit | `Intl.RelativeTimeFormat` with `numeric: 'auto'` |
| `formatRelativeDay(ts)` | "yesterday" in DM previews: the calendar day, so 23:00 and 01:00 are a day apart | `Intl.RelativeTimeFormat`, `day` unit |
| `formatNumber(n)` | Counts shown as bare numbers | `Intl.NumberFormat` |
| `formatPercent(p)` | Sliders that show `150%` | `Intl.NumberFormat` `style: 'percent'` |
| `formatBytes(n)` | Storage panel, transfer indicator | `Intl.NumberFormat` with `style: 'unit'` and the right byte unit |

`formatDmTimestamp` in `dmFormatters.ts` keeps its today/yesterday/this-year
branching but delegates every branch to these formatters, and the "Yesterday"
branch is `formatRelativeDay` rather than a literal.

The elapsed and calendar variants exist because they answer different
questions: a message sent at 14:05 yesterday is "20 hours ago" as elapsed time
and "yesterday" as a calendar day, and each UI wants one of the two.

Tests set the language explicitly through `i18n.changeLanguage` before
asserting on formatted output. Asserting `Mar 15` without setting the
language is the bug the previous `dmFormatters.test.ts` had.

---

## Loading

English is bundled with the app as the fallback and is always present.
Every other language is loaded on demand, one namespace at a time, through
a small i18next backend in `loader.ts` built on `import.meta.glob` with lazy
imports. Vite splits each `<lng>/<namespace>.json` into its own chunk, so a
Russian user downloads Russian and nothing else, and an English user
downloads no catalogs beyond the bundled ones.

Missing keys in a non-English catalog fall back to English at runtime
(i18next `fallbackLng`), so a partially translated surface degrades to
English rather than showing a key.

The store shape for `CustomTypeOptions.resources` is derived from the
English catalogs (`resources.ts` imports every `en/*.json`), which is what
makes keys typed without maintaining a parallel type by hand.

---

## Language selection and persistence

Detection order on startup:

1. Stored choice under `localStorage['backspace-language']`.
2. `navigator.languages`, first entry whose base language is supported.
3. `en`.

Each entry in `supportedLanguages` carries a `released` flag. Only released
languages appear in the picker (`availableLanguages`) or can be chosen by
detection; a stored choice for an unreleased language is ignored. Russian and
German are complete in code and tests but stay unreleased until every surface
is translated, so a release cut between the foundation and 1.1.0 is
English-only by construction rather than half translated. The PR that empties
the pending list flips the flags. Tests reach the unreleased languages with
`setLanguage` or `initI18n({ releasedLanguages })`; people reach them with
`?lang=de` on the URL, which works in development builds only and is never
persisted.

Detection alone never writes the stored choice. A user who has not picked a
language keeps following their browser; only the picker persists.
`initI18n` resolves after the detected language's catalogs are loaded, and
`main.tsx` awaits it before the first render, so there is no English flash.

The selector lives in the user settings modal, Account panel, section
"Language". It lists `supportedLanguages`, showing each language by its
`nativeName` (English, Русский, Deutsch); the list is not translated,
because a user who cannot read the current language needs to find their own.

Changing the language:
- Persists the choice.
- Sets `document.documentElement.lang` and `dir` (from the language's `dir`
  field; all shipped languages are `ltr`, the field exists so an RTL language
  is one catalog and one entry).
- In the desktop app, sends `set-language` over IPC so the main process
  relabels the tray and application menus.

The choice is per device, not per account. It is not synced to the server;
a user's language is a property of the machine in front of them.

---

## Server errors

The server never localizes. It sends a stable machine-readable code, and the
client owns the words.

Wire contract (`packages/shared/src/errors.ts`):

```ts
interface ApiErrorBody {
  error: string;       // English text, kept for older clients and logs
  code?: ErrorCode;    // stable identifier, e.g. 'current_password_incorrect'
  statusCode: number;
  details?: Record<string, string | number>; // interpolation values, e.g. { max: 32 }
}
```

`ErrorCode` is a snake_case string union in `packages/shared`. The shape
follows the codes that already existed before this system (`recipient_deleted`
in the DM routes, the friend-request codes in `social.ts`,
`PEER_EXISTS_RESET_REQUIRED` in peering), all of which are members. A code
never changes meaning once shipped.

Routes send errors through `sendError(reply, status, code, details?)` in
`packages/server/src/utils/httpErrors.ts`, which looks up the English text
for the code and fills the body. `ERROR_MESSAGES` is typed
`Record<ErrorCode, string>`, so adding a code without English text does not
compile. Routes that have not been converted keep sending `{ error,
statusCode }`; the contract is backward compatible in both directions because
a desktop app and an instance version independently, and because the web
client talks directly to federated peers that may run any version.

The client's `HttpError` carries `code` and `details`, parsed by
`HttpError.fromBody`. It accepts a `code` field, and, for the older routes
that put the code in `error` itself, an `error` value that is a known code.
Unknown codes are dropped, so a peer cannot inject arbitrary catalog keys.
Components render an error with `describeError(err)` from `i18n/errors.ts`,
which returns the localized `errors:` string for the code, interpolating
`details`, and falls back to the server's English `error` text when there is
no code or the catalog has no entry. A `code` that is missing from the
`errors` namespace is a check-script failure, so every code shipped by the
server has words in every language.

Federation: error bodies relayed from a peer instance follow the same
contract, so a code from a newer peer is localized and a bare `error` from
an older peer is shown as is.

Converted so far: the profile, password and account-deletion routes in
`users.ts`. Auth, joins, uploads, friends and DM management follow with their
surface sweeps.

The conversion order is by what users actually see: auth, joining spaces
and DMs, uploads, friend requests, DM management. Internal and admin errors
follow as their panels are swept.

---

## System messages

DM system messages (member added, removed, left, ownership transferred, call
events, space invites) are stored and relayed as structured JSON with a
`type` discriminator and identity fields, never as English text. The client
renders them through `dmFormatters.ts`, which now reads the `dm:system.*`
keys. This is the only kind of server-authored text shown in chat, and it is
already federation safe because peers relay the structure, not a rendering.

If a future feature stores a human sentence on the server, that is a bug in
the feature, not a localization task.

---

## Desktop main process

The main process shows a handful of strings outside the renderer: tray menu
items, the application menu (macOS, and the accelerator-only Edit menu on
Windows and Linux), the update items, the recovery page and the instance
picker. The menu strings live in `packages/desktop/src/l10n.ts` as a small
typed catalog with `en`, `ru` and `de` entries; `translateDesktop(language,
key, values?)` reads it. The recovery and instance-picker pages carry their
own inline `STRINGS` tables, because they are shown precisely when the
renderer is unavailable.

Language source, in order: the last `set-language` IPC message from the
renderer, persisted as `language.json` next to `instance-url.json` in
userData, then `app.getLocale()` mapped through the same base-language rule
as the web, then `en`. `getDesktopLanguage()` resolves it; the pages receive
it as `?lang=` on their `loadFile` URL. On `set-language`, main persists the
choice and rebuilds every menu it owns.

`buildTrayMenuTemplate` and `buildAppMenuTemplate` take the language as a
trailing parameter that defaults to English, so the pure template builders
stay testable without Electron.

Notification titles are composed by the renderer and passed to
`showNotification`, so they need no main-process work.

---

## Consistency check

`scripts/check-i18n.mjs` runs in `pnpm typecheck` and before the web build.
It fails on:

1. A key present in `en` and missing from another language, or vice versa.
2. A `{{placeholder}}` set that differs between languages for the same key.
3. A plural key missing a CLDR category for its language.
4. A `t()` call that passes `count` to a key without plural forms.
5. A non-English value byte-identical to the English one, outside the
   allowlist in `scripts/i18n-allowlist.json` (brand names, "OK", URLs).
6. A direct `toLocale*` or `Intl.*` call in the web package outside
   `formatters.ts`.
7. An `ErrorCode` with no entry in `errors.json`.
8. A literal user-facing string in JSX or in a `addToast(...)` call, in any
   file not listed in `scripts/i18n-pending.txt`. That file is the list of
   source files not yet swept; each sweep PR removes its files from it, and
   the list reaching zero is the definition of done for the first localized
   release. `node scripts/check-i18n.mjs --write-pending` regenerates it from
   the current tree. A line that is a false positive carries
   `// i18n-check: allow-literal` on the line above.

The check reports every finding at once, with file and line, so a sweep PR
can be fixed in one pass.

---

## Sweep order and translation workflow

Surfaces are converted one PR at a time, in the order users meet them: auth,
settings (done in the foundation PR as the reference), chat, dm, voice,
spaces, social, search, uploads, mobile, federation, admin, desktop. Each
PR ships `en`, `ru` and `de` for its namespace.

The Russian translation comes from the community. st7105 translated the
whole app in PR #45, and that PR also established the detection order, the
`backspace-language` storage key and the idea of a parity check, all of
which are kept here. The Russian values are carried over matched by English
text, with `Co-authored-by` credit on every commit that carries them, and
st7105 is asked to review the result. German is written by the maintainers
and marked for a native review before release.

Catalogs are Weblate compatible. No hosted translation platform is
configured yet; when one is, it points at `packages/web/src/locales` and
`en` is the source language.

---

## Adding a language

1. Create `packages/web/src/locales/<lng>/` with every namespace file.
2. Add `{ code, nativeName, dir }` to `supportedLanguages`.
3. Add the entry to the desktop catalog in `l10n.ts` and the recovery
   window's inline catalog.
4. Run `pnpm typecheck`; the check script confirms parity.

Nothing else. If a fourth step turns out to be needed, the fix is to remove
the need, not to document the step.

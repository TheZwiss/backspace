# Localization done properly, and the 1.0.6 release that precedes it

Written 2026-09-04 before a context compact. Everything below was verified in the
session that wrote it; the "open" items are marked.

## Decisions already made by Jannis

- Do the localization ourselves end to end (foundation plus the full surface
  sweep). Carry the contributor's Russian strings over with `Co-authored-by`
  credit. Close #45 with a proper thank-you. Do not ask the contributor to
  restructure it.
- Languages for the first localized release: English, Russian, German. Jannis
  wants a native pass on German before release; write it, flag it.
- Sequencing: release 1.0.6 first (main has #48 Flatpak and #90 policy), then
  localization lands as 1.1.0.
- Outward communication: plain human prose, no em dashes, no bullet-label slop.
  Be warm to contributors.

## Step 1: release 1.0.6

Procedure, taken from the 1.0.5 release (`29cb8ce8`, PR #88):

1. Branch from main. Run `node scripts/bump-version.mjs 1.0.6`. It sets the
   version in six manifests: root `package.json`, `packages/{desktop,server,
   shared,web}/package.json`, `scripts/metrics/package.json`.
   `test/version-consistency.test.ts` enforces they agree. Lockfile stays
   untouched (precedent from 1.0.3, 1.0.4, 1.0.5; workspace-internal versions).
2. Commit `chore: release 1.0.6`, open a PR whose body says "Version bump only"
   and points at the content PRs (#48, #90). Squash merge without `--subject`
   (GitHub appends `(#N)`; `--subject` suppresses it).
3. Tag the merge commit `v1.0.6` (lightweight tag on the commit, as previous
   releases are) and push the tag. That fires `release.yml`.
4. Watch `release.yml`. This is the first run of the new three-job Flatpak chain
   from #48: `prepare-flatpak-metadata` regenerates the pin, `node-sources.json`
   and the AppStream entry; `validate-flatpak-metadata` builds x86_64 and
   aarch64 from the result; `update-flatpak-metadata` opens
   `automation/flatpak-v1.0.6`. Review and merge that PR. Only after it merges
   may Flathub submission happen (memory: flatpak-packaging-pr48).
5. Write release notes on the GitHub release (the workflow creates a draft with
   an empty body). Plain prose, no em dashes.

## Step 2: what is wrong with #45 (feat(web): add localization support)

Branch fetched locally as `pr45`. 159 files, +7,468/−2,415. Author st7105
(same person as #48). Closes #33, which was opened by a different user, d00xD,
a Russian user running Backspace on a Raspberry Pi 5 because Discord is blocked
there. Thank both when closing/commenting.

What #45 gets right and we keep:
- `i18next` 25.5.2 + `react-i18next` 15.7.3. Right library: mature, JSON
  catalogs Weblate/Crowdin consume, CLDR plural suffixes for Russian.
- Detection order (stored choice, then browser languages), persisted under
  `backspace-language`, `document.documentElement.lang` kept in sync.
- A `check:i18n` script wired into `typecheck` and `build` that enforces
  catalog parity and `{{placeholder}}` consistency. Keep the idea, rewrite it
  against the new convention.
- The Russian translations themselves: 2,228 strings in
  `packages/web/src/locales/ru/translation.json`. Reuse the *values*, not the
  keys.

What is structurally wrong and must not be merged as is:
1. Keys are machine-generated and leak the extraction process. Evidence:
   `runtime.selected.dmFormatters.unknown` and `...unknown2`;
   `ui.JoinPage.yourPasswordIsVerifiedLocallyThenUsedTo` (the English sentence
   as the key); 2,151 of 2,228 keys under `ui.*`, `runtime.manual.*`,
   `runtime.selected.*` (tool categories, not meaning); scoped by source file
   name so a component rename invalidates its keys.
2. Plurals were wrapped, not restructured. Only 10 plural keys exist. A key
   `englishPluralSuffix_one/few/many/other` is `""` in Russian, meaning English
   still builds `file${n===1?'':'s'}` somewhere and Russian just blanks it.
   Wrong for Russian (1 файл / 2 файла / 5 файлов).
3. No typed keys. `translate(key: string)` accepts anything. No
   `CustomTypeOptions` resource typing.
4. All locales bundled eagerly (`import en`, `import ru` in `i18n.ts`,
   passed as `resources`). Every user downloads every language.
5. Scope stops at the web renderer. Nothing in `packages/server`,
   `packages/shared`, `packages/desktop` changed. Consequences: server error
   strings stay English (client does `err.message || translate(...)` and the
   server's English wins); desktop main-process strings (tray menu labels in
   `recovery.ts`, `recovery.html`, notification titles) stay English.
6. Dates: `formatDmTimestamp(createdAt, locale = 'en-US', yesterdayLabel =
   'Yesterday')` in #45 takes a locale parameter but defaults to en-US, so it
   is correct only if every caller passes `i18n.language`. Other date sites
   unknown (inventory grep failed on zsh globbing; redo with quoted
   `--include='*.tsx'`).
7. The language selector uses per-language keys (`language.english`,
   `language.russian`) when `supportedLanguages[].nativeName` already exists.

## Step 3: target architecture (the spec to build)

Write this into `docs/systems/localization.md` as the subsystem spec first,
then implement. Add the row to CLAUDE.md's subsystem table.

Library: keep `i18next` + `react-i18next`. Add nothing else unless a concrete
need appears (no ICU plugin needed; i18next plural suffixes cover ru/de/en).

Keys:
- Semantic, surface-scoped, never derived from English text or file names.
  Shape: `<surface>.<element>.<meaning>`, e.g. `chat.composer.placeholder`,
  `settings.desktop.autoLaunch.label`, `voice.controls.mute`. Surfaces are
  product areas (auth, chat, dm, voice, spaces, settings, admin, federation,
  social, search, uploads, desktop, mobile, common), not components.
- One namespace file per surface under `packages/web/src/locales/<lng>/`,
  so lazy loading and translator assignment work per area.
- Typed: declare `CustomTypeOptions` with `resources` typed from the English
  catalogs so `t('bad.key')` is a compile error and keys autocomplete.
  Validate that `translate()`/`t()` call sites reference existing keys; the
  typing does this for TS call sites, the check script covers `<Trans>` and
  dynamic keys.

Plurals: every count goes through a plural key (`_one/_few/_many/_other` as
each language needs; Russian needs all four, German and English `_one/_other`).
No suffix tricks, no `${n} thing${s}`. Audit every count site on main.

Dates, times, numbers: exclusively through `Intl.DateTimeFormat`,
`Intl.RelativeTimeFormat`, `Intl.NumberFormat`, always given the *selected*
i18n language, never the bare browser default. One small `formatters.ts` that
takes the language from i18n so callers do not pass locales around. Fix the
locale-sensitive month assertions in `dmFormatters.test.ts` by making the
test set the locale explicitly.

Loading: English bundled as the fallback; other locales lazy `import()` per
namespace via a small resource loader. Vite code-splits them.

Server errors: today routes send `{ error: 'English text', statusCode }` and
the client throws `HttpError(status, message)`. Add stable error codes in
`packages/shared` (an `ErrorCode` string union) and have routes send
`{ error, code, statusCode }` with `error` kept for older clients. The client
maps `code` to a localized message and falls back to `error`. This is a
shared-contract change; keep it backward compatible in both directions because
desktop app and instance version independently and federation relays errors.
Do the mapping for the error sites users actually see (auth, joins, uploads,
friends, DMs); document the rest as English-passthrough.

System messages: DM system messages are already structured
(`dmFormatters.ts` renders from `data.targetDisplayName`, `reason`, etc.), so
client-side localization is legitimate there. Confirm space/channel system
messages are also structured, not stored English text. If any are stored as
text, that is a server change to structure them, and it must be
federation-safe (relayed as structured events).

Desktop main process: tray/app menu labels (`recovery.ts`), `recovery.html`,
notification titles. The renderer tells main the selected language over IPC
(`set-language`), main keeps a tiny catalog for its handful of strings, and
falls back to `app.getLocale()` before the renderer has said anything.

Translation workflow: catalogs stay Weblate-compatible JSON. No hosted platform
set up in this pass; note it as a follow-up. `check:i18n` rewritten to enforce:
parity across all shipped locales, placeholder parity, no untranslated values
outside an allowlist, no count interpolation outside a plural key, and no
literal user-facing strings in JSX (heuristic, allowlisted).

Language selector in settings: driven by `supportedLanguages[].nativeName`,
shows each language in its own name.

RTL: not needed for en/ru/de; set `dir` from a per-language flag anyway so it
is one line when Arabic or Hebrew arrives.

## Step 4: execution order

1. Redo the two failed inventories (date sites, count sites) with quoted globs.
2. Write `docs/systems/localization.md` (the spec above, in the house voice).
3. Foundation PR: i18n setup, typed resources, loader, formatters, check
   script, `packages/shared` error codes, desktop IPC, language selector, plus
   one reference surface (settings) fully converted in en/ru/de. Tests for the
   loader, formatters, plural helper, error-code mapping, check script.
4. Sweep PRs per surface, each with en/ru/de catalogs, each reviewable on its
   own. Russian values lifted from `pr45:packages/web/src/locales/ru/translation.json`
   by matching English text; German written fresh and flagged for a native
   pass.
5. Close #45 with a comment that explains the structural reasons plainly,
   thanks st7105, says their Russian is being carried over with credit, and
   invites them to review the Russian result. Comment on #33 to d00xD that it
   is happening. Do this when the foundation PR is open, not before, so the
   closure points at real work.
6. Release 1.1.0 when the sweep is complete.

## Facts worth not rediscovering

- Repo has no `ErrorCode` anything in `packages/shared` today.
- `packages/web/src/api/client.ts:384` is where the client turns a failed
  response into `HttpError(status, body.error)`.
- Fork PR workflow runs need approval per push; recipe in memory
  `flatpak-packaging-pr48`.
- Local Node is 25; server tests need the `better-sqlite3` prebuild trick in
  memory `running-server-tests-node`. Web and desktop tests run as is.
- Never commit as anything but `151788261+TheZwiss@users.noreply.github.com`.

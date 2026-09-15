# Desktop download tab implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development to implement this plan task by task. Each task is a brief for one implementer agent: files, interfaces, tests, docs, acceptance criteria, commit subject. Implementers write the code; the plan does not.

**Goal:** the Desktop tab under App Settings shows in the browser too, offering the right desktop download for the visitor's OS and architecture, built from the instance's own version.

**Architecture:** one pure detection-and-links module under the web platform layer, one presentational panel that calls it, and a two-line change in the settings modal that drops the Electron gate on the tab and picks the panel by environment. No server change, no new dependency, no network call.

**Tech stack:** React 18, TypeScript strict, Vitest with Testing Library, i18next catalogs (`en`, `de`, `ru`), Tailwind with the Aether Drift tokens.

**Spec:** the design agreed in chat on 2026-09-08, restated here in full. There is no separate spec file.

## The design, restated

- The Desktop tab button in `UserSettings.tsx` currently renders only when `isElectron()` is true, in both the desktop sidebar and the mobile tab list. Both gates go. The tab keeps its position under the App Settings heading.
- Inside the desktop app the tab renders the existing `DesktopPanel`, untouched.
- In the browser it renders a new `DesktopDownloadPanel`: a title, one line saying what the app adds (voice polish, activity detection, global keybinds), one highlighted primary download for the detected platform, the remaining builds as plain links grouped by platform, and an "All releases" link to the GitHub releases page.
- Windows never needs an architecture: the release carries a combined installer, `Backspace-<version>.exe`, built with `--win --x64 --arm64`, that picks the architecture at install time. The release also carries `Backspace-<version>-x64.exe`, `Backspace-<version>-arm64.exe`, two Mac `.zip` files, blockmaps and updater metadata. None of those is offered; the combined installer is enough.
- macOS needs one: `Backspace-<version>-arm64.dmg` or `Backspace-<version>-x64.dmg`. Chromium exposes the architecture through user-agent client hints; Safari and Firefox do not, and Safari on Apple Silicon reports itself as Intel. Fallback: Apple Silicon, with the Intel build as the first secondary link.
- Linux needs one too: `Backspace-<version>-x86_64.AppImage`, `Backspace-<version>-arm64.AppImage`, `Backspace-<version>-amd64.deb`, `Backspace-<version>-arm64.deb`. Fallback: x64. The deb versus AppImage choice cannot be detected, so the primary is the AppImage and the deb for the same architecture is the first secondary link.
- A phone or tablet, or an OS that is none of the three, gets no primary: a short note that the app runs on Windows, macOS and Linux, then the full list.
- Links are built from `InstanceInfoResponse.version`, which `UserSettings.tsx` already fetches for the source-code footer. A version that is not a plain `major.minor.patch` makes every link point at the releases page instead. A plain version whose tag is not published yet links to a missing asset; accepted, the "All releases" link is the recovery.
- The desktop app checks for updates ten seconds after launch. Windows and AppImage install them; macOS today offers a download link because the bundle is ad-hoc signed (see desktop.md "Update capability"). Linking the instance's version is still right: the app tells the user about anything newer.
- Not included: a profile-menu entry, any change to release naming, a Flatpak link.

## Global constraints

- TypeScript strict, no `any`, no placeholder code, every component complete. See `CLAUDE.md`.
- Every user-facing string goes through i18next with a semantic key under the `settings` namespace, shipped in `en`, `de` and `ru` in the same task. Key shape is `settings:desktopDownload.<element>.<meaning>`; see `docs/systems/localization.md`. `node scripts/check-i18n.mjs` must pass.
- No em dashes, no marketing register in copy. Plain sentences.
- Surfaces follow `docs/systems/design-system.md`: this panel is structural content inside the settings modal, so matte classes like the other panels, no glass. Copy the row and button classes from `DesktopPanel.tsx` and `AppearancePanel.tsx` rather than inventing new ones.
- The GitHub repository URL is `https://github.com/TheZwiss/backspace`. Release assets live under `releases/download/v<version>/<filename>`; the listing is `releases`; there is no fixed-name "latest" asset because filenames carry the version. The new `RELEASES_URL` is `/releases` on purpose; `updateStore.ts` and the desktop package keep `/releases/latest` because they mean "the newest". Do not align one to the other.
- Run `pnpm dev` and the server tests with the Node version in `.nvmrc`; the machine's default Node breaks better-sqlite3. Web tests and the web typecheck run fine on the default Node.
- `window.backspace` is the desktop preload contract and must not change. See `docs/systems/desktop.md`.
- Tests are Vitest with `@testing-library/react`, run with `cd packages/web && npx vitest run <path>`. Typecheck with `cd packages/web && npx tsc --noEmit -p .`.
- Work on the local branch `feat/desktop-download-tab`. Commit per task. Do not push and do not open a PR; Jannis tests the whole result first.

---

### Task 1: detection and link builder

**Files:**
- Create: `packages/web/src/platform/desktopDownload.ts`
- Create: `packages/web/src/platform/desktopDownload.test.ts`

**Interfaces produced (exact names, later tasks depend on them):**

```ts
export type DesktopOs = 'windows' | 'mac' | 'linux' | 'other';
export type DesktopArch = 'x64' | 'arm64';
export interface DetectedPlatform {
  os: DesktopOs;
  arch: DesktopArch | null;   // null when unknown or irrelevant (windows, other)
  archGuessed: boolean;       // true when arch came from the platform default, not the browser
}
export interface DesktopDownload {
  os: Exclude<DesktopOs, 'other'>;
  arch: DesktopArch | null;   // null for the combined Windows installer
  kind: 'exe' | 'dmg' | 'appimage' | 'deb';
  filename: string;
  url: string;
}
export interface DesktopDownloadLinks {
  primary: DesktopDownload | null;
  others: DesktopDownload[];  // every remaining build, ordered windows, mac, linux; within a platform the detected arch first
  allReleasesUrl: string;
}
export const RELEASES_URL: string;                 // 'https://github.com/TheZwiss/backspace/releases'
export function detectDesktopPlatform(nav: NavigatorLike): Promise<DetectedPlatform>;
export function buildDesktopDownloads(version: string, detected: DetectedPlatform): DesktopDownloadLinks;
```

`NavigatorLike` is a small structural type the module defines so tests can pass a plain object: `{ userAgent: string; maxTouchPoints?: number; userAgentData?: { platform?: string; mobile?: boolean; getHighEntropyValues?: (hints: string[]) => Promise<Record<string, unknown>> } }`. The panel passes `window.navigator`. In jsdom `userAgentData` is undefined and `maxTouchPoints` is undefined, which the type allows.

**Detection rules:**
- OS from `userAgentData.platform` when present (`Windows`, `macOS`, `Linux`, `Chrome OS`, `Android`, `iOS`), else from the user-agent string. `Android`, `iOS`, `Chrome OS`, anything with `Mobile`, `iPhone`, `iPad`, `Android`, `CrOS` in the UA, `userAgentData.mobile === true`, and a Mac with `maxTouchPoints > 1` (iPadOS Safari presents as a Mac) are all `other`.
- Architecture from `getHighEntropyValues(['architecture', 'bitness'])` when the function exists and resolves: `architecture === 'arm'` is `arm64`; `architecture === 'x86'` with `bitness === '64'` is `x64`; anything else falls through. A rejected promise falls through. Then the UA string, case-insensitive: `aarch64` or `arm64` mean `arm64`; `x86_64`, `x64`, `Win64`, `WOW64` mean `x64`; `armv7l` and `armv8l` are 32-bit and fall through. Then the default: mac `arm64`, linux `x64`, both with `archGuessed: true`. Windows and other get `arch: null, archGuessed: false`.

**Link rules:**
- Filenames exactly as electron-builder emits them; see the design section. Base `https://github.com/TheZwiss/backspace/releases/download/v${version}/`.
- The full build list is always seven entries: windows combined exe, mac arm64 dmg, mac x64 dmg, linux x86_64 AppImage, linux arm64 AppImage, linux amd64 deb, linux arm64 deb. `primary` is removed from `others`.
- Primary by platform: windows exe; mac dmg for the detected arch; linux AppImage for the detected arch; other has no primary.
- `others` ordering: windows, then mac, then linux. Within mac and linux, order by `detected.arch`; when it is null use the platform default (mac `arm64` first, linux `x64` first). The detected arch applies to both platforms regardless of the detected OS. For linux the AppImage precedes the deb within an arch.
- A version that fails `/^\d+\.\d+\.\d+$/` produces links whose `url` is `RELEASES_URL` for every entry, primary included.

**Tests (real behaviour, no mocks beyond the navigator object):**
- OS detection for each of: Chrome on Windows with client hints, Firefox on Windows by UA, Safari on macOS by UA, Chrome on macOS with hints saying `arm`, Chrome on Linux with hints saying `x86` and bitness `64`, Firefox on Linux with `x86_64` in the UA, Android Chrome (hints say Android), iPhone Safari, iPad Safari (Mac UA, `maxTouchPoints` 5), a Linux UA with `aarch64`.
- `getHighEntropyValues` rejecting falls back to the default with `archGuessed: true`.
- Link builder: primary and `others` order for windows, mac arm64, mac x64, linux x64, linux arm64, other; the seven filenames for version `1.2.1`; the dev-version case.

**Acceptance:** `npx vitest run src/platform/desktopDownload.test.ts` green; `npx tsc --noEmit -p .` clean in `packages/web`; no other file touched.

**Commit:** `feat(web): detect the desktop platform and build release download links`

---

### Task 2: the download panel and its strings

**Files:**
- Create: `packages/web/src/components/modals/settingsPanels/DesktopDownloadPanel.tsx`
- Create: `packages/web/src/components/modals/settingsPanels/DesktopDownloadPanel.test.tsx`
- Modify: `packages/web/src/locales/en/settings.json`, `packages/web/src/locales/de/settings.json`, `packages/web/src/locales/ru/settings.json` (new `desktopDownload` block in each)
- Modify only if the check script flags a value: `scripts/i18n-allowlist.json` (a flat JSON array of whole values)

**Interfaces consumed:** everything exported by `packages/web/src/platform/desktopDownload.ts` (Task 1), with the exact names listed there.

**Interface produced:** `export function DesktopDownloadPanel(props: { version: string | null }): JSX.Element`. `version` is `InstanceInfoResponse.version` or `null` while instance info has not loaded; `null` renders the panel with every link pointing at the releases page, the same as a dev version.

**Behaviour:**
- On mount, call `detectDesktopPlatform(window.navigator)` in an effect; until it resolves, render the title, the intro line and the "All releases" link, no build list. Guard against setting state after unmount.
- Heading from a new `settings:desktopDownload.title`, values copied from `settings:desktop.title` (`en` Desktop, `de` Desktop, `ru` Приложение), rendered with the same `<h2 className="text-lg font-semibold text-txt-primary mb-6">` as every other panel (see `DesktopPanel.tsx` around line 244). Panels title themselves from their own block, never from `nav.tabs.*`.
- Intro line: one sentence on what the app adds. Then the primary as a filled button-styled link (`px-3 py-1.5 text-sm font-medium text-white bg-accent-primary hover:bg-accent-primary/80 rounded-lg transition-colors`, copied from the download action in `DesktopPanel.tsx`), labelled "Download for Windows" / "Download for macOS (Apple Silicon)" / "Download for macOS (Intel)" / "Download for Linux (AppImage, x64)" and so on. Select keys through `Record<...>` maps of literal key strings so the typed `t` checks them; no template-literal keys and no concatenation of English words in code.
- When `archGuessed` is true, a small tertiary line under the primary says the architecture was assumed and names the other build with a `{{build}}` placeholder (plain text, no link; the other build is already the first entry of the list below). The placeholder must appear in all three languages.
- For `other`, a tertiary note that the desktop app runs on Windows, macOS and Linux, then the full list.
- The remaining builds as a plain list of links, each with the platform, the architecture, and the file kind, using `text-txt-secondary hover:text-txt-primary` like other secondary actions.
- "All releases" as a link to `allReleasesUrl` at the bottom.
- Every link has `target="_blank"` and `rel="noopener noreferrer"`.
- No fetches, no stores, no `window.backspace` access.

**Strings:** add a `desktopDownload` block under the `settings` namespace with keys for the title, the intro, the primary label per platform and arch, the guessed-arch note, the unsupported-platform note, the list item pattern, and the all-releases link. Ship `en`, `de` and `ru`. Existing wording to match: `settings:desktop.updates.download` is "Download" / "Herunterladen" / "Скачать". Brand and platform names (`Backspace`, `Windows`, `macOS`, `Linux`, `AppImage`, `Apple Silicon`, `Intel`) are allowed to stay untranslated; add any that the check script flags to `scripts/i18n-allowlist.json`. Run `node scripts/check-i18n.mjs` from the repo root and make it pass.

**Tests (Testing Library, mock only `../../../platform/desktopDownload` so the platform is deterministic):**
- Windows: the primary link text names Windows and its href is the combined exe for the given version.
- macOS with a guessed arch: the note about the assumed architecture is present and the Intel build is in the list.
- `other`: no primary, the unsupported note is present, seven links plus the releases link.
- `version` null: every href equals the releases URL.
- Links carry `rel="noopener noreferrer"`.

**Acceptance:** panel tests green; `npx tsc --noEmit -p .` clean in `packages/web`; `node scripts/check-i18n.mjs` clean; no changes outside the listed files.

**Commit:** `feat(web): desktop download panel for the browser`

---

### Task 3: wire the tab, docs, and the full gate

**Files:**
- Modify: `packages/web/src/components/modals/UserSettings.tsx` (the two `isElectron() &&` tab buttons at roughly lines 168 and 232 on current main, and the `tab === 'desktop'` panel switch at roughly line 282)
- Modify: `docs/systems/desktop.md`: add `### Desktop tab in the browser` at the end of the Auto-Update section, before "Release publishing" (around line 454), stating the tab now exists in the browser, what it shows, that the primary is built from the instance version, and that the combined Windows installer is the one offered.
- Modify: `docs/systems/design-system.md` "Settings organization" (lines 18 to 27): rewrite the parenthetical that currently says the Desktop tab is Electron-only and would hide a preference from the browser. New wording: the browser shows the Desktop tab only as a download offer, so a preference placed there would be unreachable outside the app. Do not append a contradicting line; replace the sentence.

**Interfaces consumed:** `DesktopDownloadPanel({ version })` from Task 2; `isElectron()` from `packages/web/src/platform/platform.ts`; the existing `instanceInfo` state in `UserSettings.tsx`.

**Changes:**
- Remove the `isElectron() &&` guard from both Desktop tab buttons so the tab always renders under App Settings.
- In the panel switch, render `<DesktopPanel />` when `isElectron()` and `<DesktopDownloadPanel version={instanceInfo?.version ?? null} />` otherwise.
- Leave the deep-link allowlist for `modalData.tab` as it is; it already excludes `desktop`, and nothing links there yet.

**Tests:**
- There is no `UserSettings.test.tsx` yet; create it. The modal needs: `useUIStore` with `activeModal: 'userSettings'`, `modalData: {}`, `isMobile: false`, `closeModal`; `useAuthStore` with a `user` and `logout`; `useSettingsStore` (reached through `hooks/useInstanceUpdateBadge.ts`); `api.instance.info` resolving `{ version: '1.2.1', sourceCodeUrl, commit, ... }`; and for the Electron case `window.backspace` plus the `updateStore` mock exactly as in `settingsPanels/DesktopPanel.test.tsx`. The store-mock idiom to copy is `settingsPanels/AccountPanel.detachedNotice.test.tsx` (selector-aware `Object.assign(fn, { getState, setState, subscribe })`). `vi.mock` every sibling panel (Account, Appearance, Voice, Privacy, Connections, Keybinds, Instance) to a one-line stub so only the two Desktop panels render for real. Two cases: with `window.backspace` undefined the Desktop tab is present under App Settings and clicking it shows the download panel's all-releases link; with `window.backspace` defined the same click shows the existing desktop panel's title. Do not skip the test; if something in this list is wrong on the branch, fix the setup and say so in the report.

**Full gate, run from the repo root and paste the results in the report:**
- `pnpm typecheck` (this includes the i18n check)
- `cd packages/web && npx vitest run`
- `pnpm dev` under the `.nvmrc` Node starts server and web without errors; open the settings modal in the browser at `http://localhost:5173`, confirm the Desktop tab under App Settings and the download panel with the right primary for the machine you are on; stop the dev server.

**Acceptance:** all of the above green, docs updated, three commits on `feat/desktop-download-tab`, nothing pushed.

**Commit:** `feat(settings): show the Desktop tab in the browser with the download offer`

# Desktop & Electron System

Source files:
- `packages/desktop/src/main.ts` — Main process: window management, tray, IPC handlers, auto-update, deep links, app lifecycle
- `packages/desktop/src/preload.ts` — Context bridge: exposes `window.backspace` API to renderer
- `packages/desktop/src/updateCapability.ts` — Signature probe: can this build install its own updates
- `packages/desktop/src/updateStatus.ts` — Update status union, store, and the shared prompt predicate
- `packages/desktop/src/updateDismissal.ts` — Per-version dismissal persisted to userData
- `packages/desktop/src/updaterCache.ts` — Reclaims the updater download cache on manual-mode builds
- `packages/desktop/src/activityDetector.ts` — Process polling, game dictionary loading/sync, activity change detection
- `packages/desktop/src/keybindManager.ts` — Global keybinds via uIOhook, native keycode mapping, press/release tracking
- `packages/web/src/stores/keybindStore.ts` — Client-side keybind persistence (Zustand + localStorage)
- `packages/web/src/hooks/useKeybinds.ts` — Keybind dispatch: Electron IPC bridge + web capture-phase fallback
- `packages/web/src/platform/electron.d.ts` — TypeScript declarations for `window.backspace`
- `packages/web/src/platform/platform.ts` — `isElectron()` / `isElectronMac()` / `getElectronAPI()` helpers
- `packages/desktop/electron-builder.yml` — Build config, protocol registration, afterPack hook
- `packages/desktop/scripts/afterPack.js` — Cross-platform native module cleanup (critical for builds), then macOS signing
- `packages/desktop/scripts/macSign.js` — Ad-hoc macOS code signing fallback (critical: without it the app will not launch)
- `io.github.TheZwiss.backspace.yml` — Flatpak manifest (offline x86_64/aarch64 source build)
- `flatpak/` — Flatpak launcher, desktop entry, AppStream metadata, and build instructions
- `packages/desktop/resources/games.json` — Bundled game dictionary seed (versioned)

---

## Architecture Overview

The desktop app wraps the Backspace web client in Electron with:
- **Main process** (`main.ts`): Window lifecycle, tray icon, IPC handler registry, auto-update, deep linking, activity detection, keybind manager
- **Preload bridge** (`preload.ts`): Exposes `window.backspace` API via `contextBridge` with full sandbox isolation (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`)
- **Renderer**: The standard web client, detecting Electron via `typeof window.backspace !== 'undefined'`

The desktop package compiles to CommonJS (`module: "commonjs"`) targeting ES2022. Electron version: 40+.

---

## Window Management

### Creation (`main.ts:createWindow()`)

```
Default size: 1280 x 800
Minimum size: 940 x 500
Title bar: hiddenInset (macOS), hidden with titleBarOverlay (Windows/Linux)
Title bar overlay: bg #0b0b10, symbol #d8d8de, height 32px
Background color: #313338
```

### State Persistence

Window state is saved to `{userData}/window-state.json`:

```typescript
interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized: boolean;
}
```

| Event | Behavior |
|-------|----------|
| resize / move | Debounced save (300ms) via `saveWindowState()` |
| close | Immediate save before hide |
| maximize | Saves `isMaximized: true`; position/size stored from `getNormalBounds()` (pre-maximize geometry) |
| restore | Validates saved bounds against current displays; strips position if window would be off-screen |

Bounds validation (`validateWindowBounds`): Uses `screen.getDisplayMatching()` to find the nearest display, then checks if the window rectangle overlaps the display's work area. If not visible, position is stripped and Electron auto-centers.

### Close Behavior

Close does **not** quit the app. The `close` event is intercepted; the window is hidden instead. The `isQuitting` flag gates actual destruction. True quit only happens via:
- Tray menu "Quit"
- `app.quit()` (Cmd+Q on macOS)
- `before-quit` lifecycle event

### URL Loading Priority

1. `BACKSPACE_URL` environment variable (managed deployments)
2. Saved instance URL from `{userData}/instance-url.json`
3. No URL: loads `resources/instance-picker.html` (local HTML file)

Instance URL management functions: `loadInstanceUrl()`, `saveInstanceUrl()`, `clearInstanceUrl()` — all operate on `{userData}/instance-url.json`.

### Focus Tracking

Window `focus`/`blur` events send `window-focus-changed` (boolean) to the renderer via IPC. The web client uses this for notification suppression (no desktop notifications when the window is focused).

### External Links

`setWindowOpenHandler` intercepts all `window.open()` calls. HTTP/HTTPS URLs are opened in the default browser via `shell.openExternal()`. All popup windows are denied (`action: 'deny'`).

### In-Instance `/join/` Interception

Click-handlers on `https://...` URLs use `setWindowOpenHandler` (`packages/desktop/src/main.ts:391`). The handler intercepts URLs whose origin matches a connected instance and whose pathname starts with `/join/`, routing them in-app via the `open-internal-route` IPC channel instead of `shell.openExternal`.

State plumbing:
- Main process maintains `knownInstanceOrigins: Set<string>` populated via `set-connected-origins` IPC pushes from the renderer. Synchronously readable from inside `setWindowOpenHandler` (which must return its result synchronously).
- Renderer's `instanceStore` subscribes its own `instances` selector and forwards the connected-origin list (home + connected remotes) to main on every change, including initial mount.
- `packages/web/src/platform/deepLink.ts` (`useDeepLinkHandler`) subscribes to `onOpenInternalRoute` and calls `navigate(path)`.

Predicate scope: only intercept URLs whose host matches a **currently connected** instance. Invites for unknown instances or disconnected federated peers still open externally — that's the entry point for `JoinPage`'s federation-redirect flow and must not be hijacked.

Dev-mode caveat: if a developer runs Electron pointed at the Vite dev server (`http://localhost:5173`) while the API runs on `http://localhost:3005`, `window.location.origin` won't match the API origin and interception will not trigger. Production and standard-Electron-pointed-at-server dev are unaffected.

---

## Instance Picker

When no instance URL is configured, the app loads `resources/instance-picker.html` — a self-contained HTML page where the user enters their Backspace instance URL. The renderer communicates the chosen URL back via the `set-instance-url` IPC handler.

After navigation (both to an instance URL and back to the picker), the main process forces Electron to re-evaluate drag regions by momentarily resizing the window (+1px then back).

### Non-destructive "Change Instance" navigation

The tray menu, macOS app menu, and recovery surface all include a "Change Instance" option. This navigation is **non-destructive**: the saved instance URL is preserved when navigating to the picker. The picker's `init()` function reads the current saved URL via `getInstanceUrl()` IPC and, if one exists:

- Pre-fills the URL input with the current value.
- Shows a Cancel button (hidden by default; only shown when a saved URL exists).
- Switches the header copy from "Welcome to Backspace / Connect to your instance" to "Switch instance / Connect to a different Backspace instance, or cancel to stay."

**Cancel button behavior:** Clicking Cancel re-saves the existing URL via `setInstanceUrl` (idempotent) and navigates back to it. The saved URL is only overwritten when the user explicitly clicks Connect on a *different* URL. This means the user can always back out of an accidental "Change Instance" click.

**Loading state:** `setLoading(true)` — invoked when Connect is clicked — disables both the Connect button and the Cancel button to prevent a race between the `setInstanceUrl` calls.

---

## Auto-Launch (Start with OS)

Settings stored in `{userData}/auto-launch.json`:

```typescript
interface AutoLaunchSettings {
  openAtLogin: boolean;   // default: false; disk cache, NOT source of truth
  startMinimized: boolean; // default: true; disk cache; OS-authoritative on Windows
}
```

### Source of Truth

The OS is the source of truth for `openAtLogin` on all platforms. Disk is used only to recover values Electron does not expose:
- **Windows:** OS-authoritative for `openAtLogin` (via `executableWillLaunchAtLogin`, which honours Task Manager's `StartupApproved\Run` disable). For `startMinimized`: derived from `launchItems[].args` when an entry exists; falls back to the disk cache when no entry exists, so the user's preference survives an off/on cycle.
- **macOS:** OS-authoritative for `openAtLogin`. Disk-cached for `startMinimized` (no introspection available).
- **Linux:** OS-authoritative for `openAtLogin`. Disk-cached for `startMinimized` (we deliberately do not parse `Exec=` lines from `.desktop` files; out-of-band edits are rare and parsing shell-quoted strings is fragile).

Flatpak is the exception: Electron cannot register a host login item across the
sandbox boundary, so both auto-launch IPC handlers return disabled settings and
the renderer hides the controls. This is decided by the dedicated
`isSandboxed()` predicate and `is-sandboxed` IPC query, not by
`UpdateCapability`; sandbox restrictions and update ownership are independent
capabilities even though `FLATPAK_ID` currently affects both.

### Platform-Specific Implementation (`applyLoginItemSettings()`)

| Platform | Method | Key parameters | Rationale |
|----------|--------|----------------|-----------|
| macOS    | `app.setLoginItemSettings({ openAtLogin, openAsHidden, args })` | `openAsHidden: startMinimized`; `args: ['--hidden']` when `startMinimized` | Both detection paths covered (legacy `wasOpenedAsHidden` for macOS < 13 and `--hidden` argv for macOS 13+) |
| Windows  | `app.setLoginItemSettings({ openAtLogin, enabled, path, args, name })` | `enabled: openAtLogin`; `path: process.execPath`; `args: ['--hidden']` when `startMinimized`; `name: 'Backspace'` | `enabled` is required to clear Task Manager's `StartupApproved\Run` disable when re-enabling. `path`/`args` enable correct matching in subsequent `getLoginItemSettings`. |
| Linux    | `app.setLoginItemSettings({ openAtLogin, name, path?, args? })` | `name: 'backspace'` (deterministic `.desktop` filename); `path: $APPIMAGE` when running as AppImage; `args: ['--hidden']` when `startMinimized` | `name` ensures stable `~/.config/autostart/backspace.desktop` path. AppImage path tracks updates. |

### Startup Re-Apply

The unconditional startup re-apply was removed (it was overwriting user changes made via Task Manager / System Settings). Today the only re-apply happens on Linux/AppImage and only when needed:

```
if linux AND $APPIMAGE is set:
  read ~/.config/autostart/backspace.desktop → recordedExecPath (null if file missing)
  if saved.openAtLogin AND recordedExecPath != null AND $APPIMAGE != recordedExecPath:
    re-apply to refresh the autostart entry's Exec= path
  (a missing .desktop file is treated as user-disabled — never recreated here)
```

This keeps AppImage updates working (the AppImage moved to a new path → autostart entry needs the new path) without overriding any user-level OS state on Windows or macOS.

### Hidden-Launch Detection

At `ready-to-show`:
- `process.argv.includes('--hidden')` — primary signal on all platforms (we pass `args: ['--hidden']` everywhere when `startMinimized`).
- `app.getLoginItemSettings().wasOpenedAsHidden` — macOS-only fallback for the legacy `openAsHidden` path (macOS < 13).

If either is true, the window is created but not shown (stays in tray).

### Pure Helpers

Pure logic lives in `packages/desktop/src/autoLaunch.ts` with vitest coverage in `autoLaunch.test.ts`:
- `deriveStartMinimizedFromArgs(args)` — used by both IPC handlers on Windows.
- `parseExecPathFromDesktopFile(content)` — used by the Linux/AppImage path-refresh.
- `shouldReapplyAppImage(currentAppImagePath, recordedExecPath)` — used by the Linux/AppImage path-refresh.

---

## Tray Icon

### Icon Loading (`loadTrayIcon()`)

| Platform | Source | Notes |
|----------|--------|-------|
| macOS | `resources/tray-iconTemplate.png` (+ `@2x`) | Template image: solid black + alpha at 22×22 / 44×44; OS recolours for light/dark/active |
| Windows | `resources/tray-icon.ico` | Multi-size `.ico` (16/20/24/32/40/48); Windows + Electron auto-pick best size for current DPI |
| Linux | `resources/tray-icon.png` | Single 22×22 colored PNG (AppIndicator / StatusNotifier convention); no runtime resize |
| Fallback | Programmatic 16×16 BGRA buffer | Blurple circle (#5865f2); should not trigger now that templates ship populated |

All four assets are produced by `scripts/gen-icons.mjs` from `assets/brand/{mark.svg, mark-mono-dark.svg}` — see the [icon system spec](../superpowers/specs/2026-04-27-icon-system-design.md) for the full output matrix and `scripts/gen-icons.README.md` for regeneration workflow.

### Context Menu

| Item | Action |
|------|--------|
| Show Backspace | `window.show()` + `focus()` |
| Hide | `window.hide()` |
| Change Instance | Load picker (non-destructive — saved URL preserved), show + focus |
| Quit | Set `isQuitting = true`, `app.quit()` |

Tray click toggles window visibility (show/hide).

---

## Deep Linking

Protocol: `backspace://`

Registered via `app.setAsDefaultProtocolClient('backspace')` and in `electron-builder.yml` under `protocols`.

### Platform Handling

| Platform | Mechanism |
|----------|-----------|
| macOS | `app.on('open-url')` event |
| Windows/Linux | `second-instance` event (via single-instance lock); deep link extracted from `commandLine` args |
| Cold launch | Deep link arg stored in `pendingDeepLink`, delivered after `ready-to-show` |

### Flow

1. `handleDeepLink(url)` receives a `backspace://` URL
2. If window exists: sends `deep-link` IPC to renderer, shows + focuses window
3. If app not ready: stores in `pendingDeepLink` for delivery after `ready-to-show`

### Single Instance Lock

`app.requestSingleInstanceLock()` ensures only one instance runs. Second launch:
- Deep link arg is forwarded to the existing instance
- Existing window is restored/shown/focused
- Second instance quits immediately

---

## Auto-Update

Powered by `electron-updater`. Loaded via `require()` (not import) for graceful
degradation when not available.

Source files:
- `updateCapability.ts` — measures whether this build can install its own updates
- `updateStatus.ts` — the `UpdateStatus` union, the `UpdateStatusStore`, and the
  shared "should we interrupt the user" predicate
- `updateDismissal.ts` — per-version dismissal persisted to userData
- `updaterCache.ts` — reclaims the download cache on builds that cannot install
- `packages/web/src/stores/updateStore.ts` — the renderer mirror
- `packages/web/src/components/ui/UpdateToast.tsx` — the prompt

### Update capability, and why it is measured rather than assumed

```
type UpdateCapability = 'auto' | 'manual';
```

`getUpdateCapability()` (memoised, `updateCapability.ts`) decides in this order:

1. `!app.isPackaged` → `manual`. A dev build has no feed and must never offer to install.
2. Not darwin → `auto`. NSIS and AppImage apply unsigned updates without complaint.
3. darwin → run `codesign -d -r- <bundle>` and classify the designated requirement:
   - a bare `cdhash H"…"` → `adhoc` → `manual`
   - anything mentioning `anchor` or `certificate` → `identified` → `auto`
   - unreadable → `unknown` → `manual`
4. Any failure → `manual`.

Every uncertain path resolves to `manual` deliberately. A download link always
works, so guessing "manual" wrongly costs one extra click, while guessing "auto"
wrongly produces a button that silently does nothing.

**Nothing here hardcodes "macOS cannot update".** It measures the property that
actually decides the outcome, so the day CI signs with a Developer ID this
returns `auto` with no code change. See [desktop-security.md](desktop-security.md)
for why the ad-hoc signature makes it impossible today.

### Configuration (`initAutoUpdater()`)

```
autoDownload         = capability === 'auto'
autoInstallOnAppQuit = capability === 'auto'
Publish: GitHub (TheZwiss/backspace)
```

In `manual` mode nothing is downloaded, so no proxy server is created, Squirrel
is never invoked, and the spurious install error never fires. `purgeUpdaterCache`
also runs once at startup to reclaim archives stranded by earlier versions
(measured at 228 MB on a real macOS install, because the archive is stored
twice). The directory to delete is read from the packaged `app-update.yml`'s
`updaterCacheDirName` rather than reconstructed, and must pass
`isSafeUpdaterCacheDirName` (no separators, no traversal, mandatory `-updater`
suffix) before anything is removed.

### The `update-downloaded` trap

`MacUpdater.doDownloadUpdate()` fires `dispatchUpdateDownloaded()` **inside the
`server.listen` callback**, the moment its local proxy server is up, and *before*
Squirrel has been asked to do anything:

```js
this.server.listen(0, "127.0.0.1", () => {
    this.nativeUpdater.setFeedURL({ ... });
    this.dispatchUpdateDownloaded(event);      // fires here
    if (this.autoInstallOnAppQuit) {
        this.nativeUpdater.checkForUpdates();   // Squirrel fails later
    }
});
```

So on macOS `update-downloaded` means "the archive is on disk", **not** "the
update can be installed". Treating it as the latter is what produced a Restart
button that did nothing. `MacUpdater.quitAndInstall()` then takes a branch that
registers a listener for an event that never fires and returns, with no error and
no exception.

### Status model

One value, replaced wholesale by every event, so a stale `ready` can never
outrank a fresh `failed`:

```typescript
type UpdateStatus =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'available'; version: string }
  | { phase: 'downloading'; version: string; percent: number; bytesPerSecond: number }
  | { phase: 'ready'; version: string }
  | { phase: 'failed'; version: string | null; message: string }
  | { phase: 'up-to-date'; checkedAt: number };

interface UpdateSnapshot {
  capability: UpdateCapability;
  dismissedVersion: string | null;
  status: UpdateStatus;
}
```

`capability` and `dismissedVersion` are ambient facts about the install; `status`
is the event-driven part. They travel together so a dismissed update stays
*visible* in Settings while being *silent* in the toast. Suppressing it in main
would make it unreachable, turning "Later" into "never".

`shouldPromptForUpdate(snapshot)` is the single definition of "interrupt the
user". Both the toast and the native notification call it, so they cannot
disagree about whether the user already said later. It returns false for
`checking`, `downloading` and `up-to-date` (progress, not news), for a dismissed
version, and for a `failed` that never learned a version.

### Dismissal

Persisted to `{userData}/update-state.json` as `{ dismissedVersion }`.

It lives in the **main process, not localStorage**, because an available update
is a property of the installed app, not of whichever instance the user happens to
be connected to. Per-origin storage would re-nag anyone who switches instances
and would lose the dismissal when site data is cleared.

Exactly one version is remembered, compared by equality. Dismissing 1.0.4
silences 1.0.4 and nothing else, so 1.0.5 surfaces normally. A corrupt or
truncated file yields "nothing dismissed" rather than throwing at startup.

### Check schedule

| Trigger | Delay |
|---------|-------|
| Initial check | 10 seconds after app ready |
| Periodic check | Every 4 hours |
| Manual check | `check-for-updates` IPC from renderer |

### Event flow (main -> renderer)

| Event | IPC Channel | Payload | Condition |
|-------|------------|---------|-----------|
| Snapshot changed | `update-status-changed` | `UpdateSnapshot` | Every status or dismissal change |
| Update found | `update-available` | `{ version }` | Always (legacy) |
| Download complete | `update-downloaded` | `{ version }` | Always (legacy) |
| Error | `update-error` | `{ message, releaseUrl }` | Only if `updateConfirmed` (legacy) |

The three legacy per-event channels are **kept even though the current client no
longer reads them**. The desktop app and the instance it connects to version
independently: a newer app can be pointed at an older instance still serving a
client that calls `onUpdateDownloaded`, and removing them would throw inside that
client's `useEffect` and take the renderer down. The reverse case is handled on
the web side, where `updateStore.ts` feature-detects `getUpdateStatus` and falls
back to reconstructing a snapshot from the legacy channels.

`download-progress` is wired and drives the `downloading` phase. Pushes are
throttled to whole-percent changes, so at most 101 IPC messages per download.

Check-phase errors are recorded as `{ phase: 'failed', version: null }`, which
keeps them out of the toast while leaving them visible in Settings. Interrupting
someone because a background poll hit a flaky network is noise.

### Install

`install-update` IPC:

- `manual` → opens the releases page because there is no in-place install.
- `external` → does nothing because the package manager owns the entire update
  lifecycle and no in-app action is presented for this capability.
- otherwise → `autoUpdater.quitAndInstall()`, then a **4-second watchdog**. If the
  app is still alive and still `ready` after it, the status flips to `failed`.
  A successful install takes the app down before the timer fires. This is defence
  in depth against the silent no-op recurring on a platform we did not anticipate.

### Notification

Fires on `update-available` in manual mode and `update-downloaded` in auto mode,
suppressed when the window is focused (the in-app toast covers that) and when
`shouldPromptForUpdate` says no.

| Capability | Title | Body | Click |
|---|---|---|---|
| `auto` | Backspace update ready | Click to restart and install version X. | `quitAndInstall()` |
| `manual` | Backspace X is available | Click to open the download page. | `shell.openExternal(RELEASES_URL)` |
| `external` | — | No in-app notification; the package manager notifies the user. | — |

Win32 only: `app.setAppUserModelId('com.backspace.desktop')` is set early in
startup so notifications attribute to "Backspace" in Windows Action Center.

### Recovery integration

All `autoUpdater` events update the `RecoveryStateStore`. `UpdateState` gained
**`available-manual`**: an update exists but this build cannot install it. The
recovery surface then offers a versioned "Download Backspace X" button
(`open-releases` action) instead of "Restart to Install Update", and the tray and
macOS app menus do the same via `updateActionItem`. Without this the recovery
screen, which is the escape hatch for a user whose app will not start, would
present the one button guaranteed not to help them.

`extractErrorCode(err)` in `recovery.ts` extracts the `code` field from
`electron-updater` errors when present (string only); used to populate
`RecoveryState.lastUpdateError.code`.

### Release publishing

Flatpak is represented by the standard update-capability abstraction: when the
runtime exposes `FLATPAK_ID`, `getUpdateCapability()` returns `external`.
Updater initialization, checks, prompts, install actions, recovery controls,
and update settings all consume that capability. Flatpak owns application
updates because `/app` is immutable; the manifest also removes `app-update.yml`.
The manifest checks out a pinned source commit, installs dependencies from a
generated offline pnpm store, compiles TypeScript, and has electron-builder
produce an unpacked Linux application inside the SDK. It then installs that
output on the Electron BaseApp and uses `zypak-wrapper` for Chromium sandbox
integration.

The published manifest remains pinned to a released commit. Pull-request CI
uses `flatpak/prepare-ci-manifest.mjs` to generate an ignored manifest whose
application source is `type: dir`, so both x86_64 and aarch64 jobs compile the
actual checkout. On each `v*` tag, `release.yml` updates the source pin,
AppStream release and screenshot tag, regenerates `node-sources.json`, validates
the metadata, uploads those exact generated files, and builds their published
manifest natively on x86_64 and aarch64. Only after both builds pass does it
open or update the dedicated Flatpak metadata pull request. This validation is
part of the release workflow because pushes and pull requests created with its
`GITHUB_TOKEN` do not trigger the normal `pull_request` workflow.

CI publishes via `.github/workflows/release.yml` (tag `v*` on the public repo).
A `create-release` job runs first and creates the draft for the tag, then four
native build jobs fan out (mac arm64+x64, win x64+arm64, linux x64, linux
arm64), each uploading its installers, `.blockmap`s, and platform `latest*.yml`
manifest into that one draft. The draft must be published manually — drafts are
invisible to electron-updater.

The `create-release` job exists because electron-builder creates the release
itself when it cannot find one for the tag, and four jobs doing that lookup
concurrently can all miss. On v1.0.3 two of them created a draft and the assets
split across the pair, which needed manual consolidation before the release
could be published. Creating the draft once, ahead of the matrix, leaves the
build jobs with nothing to create.


## Recovery Mode

When the renderer fails to load or boot, the main process surfaces a native recovery UI (`resources/recovery.html`) loaded into the existing main window. Recovery is the escape hatch for failure modes that the in-app `ErrorBoundary` cannot catch — pre-render module-init throws, JS bundle/Electron incompatibility, network failures, renderer process crashes, and unrecoverable hangs.

Source files:
- `packages/desktop/src/recovery.ts` — state store, event handlers, action funnel, menu builders
- `packages/desktop/src/instanceUrl.ts` — shared instance-URL helpers (used by main.ts and recovery.ts)
- `packages/desktop/resources/recovery.html` — UI page, vanilla HTML/CSS/JS

### State Model

`RecoveryStateStore` (singleton in `recovery.ts`) owns:

```typescript
interface RecoveryState {
  mode: 'normal' | 'recovery';
  reason: { code: 'load-failed' | 'render-gone' | 'unresponsive' | 'renderer-stalled'; detail: string } | null;
  // 'available-manual': an update exists but this build cannot install it in
  // place, so the surface offers a download rather than a dead Restart button.
  updateState: 'idle' | 'checking' | 'downloading' | 'available-manual' | 'downloaded' | 'error';
  updateVersion: string | null;
  lastUpdateError: { message: string; code: string | null; at: number } | null;
  lastCheckResult: 'up-to-date' | 'failed' | null;  // transient, 5s decay
}
```

Two flags not in the public state: `inRecoveryMode` (private to the store, guards `loadFile(recovery.html)` re-entry / loop prevention) and `updateConfirmed` (local to `main.ts:initAutoUpdater`, controls whether updater errors get pushed to the renderer).

### Detection Paths

| Mechanism | Catches | Notes |
|-----------|---------|-------|
| `did-fail-load` | Network/HTTP transport failures (DNS, refused, TLS, transport-level) | Filtered by `isMainFrame`; ignores `errorCode === -3` (ERR_ABORTED). 5xx with body does NOT fire — falls through to boot timer. |
| `render-process-gone` | Renderer process termination | Filtered by reason; `clean-exit` ignored. Triggers on `crashed`, `killed`, `oom`, `launch-failed`, `integrity-failure`. |
| `unresponsive` | Main thread blocked >10s | 10s grace period; cancelled by `responsive` event. Matches Chrome's "page not responding" pattern. |
| Boot-completion ping | JS exceptions during boot, module-init throws, broken preload calls — failures the other events don't catch | `window.backspace.rendererReady()` from web side; main-side timer (20s, packaged builds only, http(s):// URLs only) |

The boot ping is **not a heartbeat** — it is a one-shot per-navigation signal. Web-side call sites:

- `packages/web/src/App.tsx` — `useEffect` with `[]` deps, fires on first commit (semantic: "renderer survived render," not "data loaded")
- `packages/web/src/main.tsx` — `ErrorBoundary.componentDidCatch`, fires when in-app error UI mounts (so the boot timer doesn't override the ErrorBoundary fallback 20s later)

Main-side gating uses a per-navigation `pingReceivedThisNav` flag (reset on `did-navigate`, set in `handleRendererReady`). If the ping arrives BEFORE the timer is armed — the typical SPA case, because `useEffect` runs in a microtask after bundle execution + React render, which is before `window.onload` that `did-finish-load` waits on — `armBootTimer` checks the flag and short-circuits. If the ping arrives AFTER the timer is armed (less-common ordering), it clears the existing timer via `clearBootTimer`. Either path means a healthy renderer never trips false recovery. The `bootArmed` flag retains its role: it ensures a `clearBootTimer` call inside the timeout callback is a no-op if the timer was already disarmed by the ping.

Navigation-aware arming: `did-navigate` (top-level non-same-document) clears any pending timer, resets `pingReceivedThisNav`, and queues a fresh arm for `did-finish-load`. `did-navigate-in-page` (SPA routing) is ignored, so React Router channel switches don't trip the timer.

### Recovery UI

`recovery.html` is loaded into the existing `mainWindow` via `loadFile()`. Mirrors `instance-picker.html` drag-region pattern (32px titlebar with `-webkit-app-region: drag`, content container with `no-drag`).

Page reads initial state via `getRecoveryState()` IPC and subscribes to `recovery-state-changed` events for live updates. All button clicks dispatch through a single `recovery-action` IPC channel with strict allowlist validation in main.

| Button | Visible | Enabled |
|--------|---------|---------|
| Reload | always | always |
| Restart to Install Update | `updateState === 'downloaded'` | always when visible |
| Check for Updates | always | not in `'checking'` / `'downloading'` / `'downloaded'` / `'available-manual'` |
| Change Instance | always | always |
| Open Releases Page | `updateState === 'error'` or `'available-manual'` | always when visible |

In `'available-manual'` the Open Releases button relabels to "Download Backspace
X". Restart to Install is never shown in that state, because the build cannot
install in place.

| Quit Backspace | always | always |

**Change Instance from recovery is non-destructive.** The saved URL is not cleared when navigating to the picker; see the Instance Picker section above for the full behavior (pre-filled input, Cancel button, header copy update).

Hint text is computed as a function of `(reason.code, updateState)` — see code in `recovery.html`. The `renderer-stalled` text intentionally avoids claiming an update is the cause (slow Pi/cold cache could also trigger it).

`lastCheckResult` provides transient inline feedback ("You're up to date" / "Update check failed") with 5s auto-decay. Without this, the user has no signal that a Check for Updates click ran when the result is no-update.

Cmd/Ctrl+R is wired as a keyboard shortcut for Reload.

### Observability Logging

`recovery.ts` emits structured `console.log` lines on entry and exit so smoke-test scripts can grep stderr without UI introspection:

| Event | Log line |
|-------|----------|
| Recovery entered | `[recovery] entered: <code> — <detail>` |
| Exited via Reload | `[recovery] exited (reload)` |
| Exited via Change Instance | `[recovery] exited (change-instance)` |

The enter log fires after the state update but before the re-entry guard, so repeated entry (reason update with no re-navigation) also logs — useful for diagnostics.

### Loop Prevention / Contained Failure

If `recovery.html` itself fails to load (corrupt resources, packaging bug), `did-fail-load` re-fires inside the recovery context. The `isInRecoveryMode` guard prevents infinite reload loops — `state.reason` updates for display purposes but no second `loadFile()` is issued. User-visible outcome is a blank window with tray-only escape (Quit). This is **contained failure**, not graceful failure: a corrupt `recovery.html` means a corrupt build that requires a fresh install.

### Hidden-Launch Override

When the app is launched with `--hidden` (autostart), `enterRecoveryMode()` always force-shows + focuses the main window. Without this, a silent boot failure during autostart would never surface to the user.

### Force-Kill Fix

The recovery surface's "Restart to Install Update" button — and the native notification's click handler — both call `autoUpdater.quitAndInstall()` **directly**. They do not rely on `autoInstallOnAppQuit`'s on-quit hook.

Why this matters: a user who Task-Manager-kills a broken app never triggers the on-quit hook; the downloaded update sits on disk. On next launch, the app loads the same broken old version. With recovery active, the user lands in recovery → clicks Restart → install applies cleanly via the direct call. The on-quit hook bypass is no longer fatal.

### Inter-Module Wiring

`recovery.ts` cannot import from `main.ts` (would create a cycle). Wiring is contract-based:

| Concern | Mechanism |
|---------|-----------|
| Shared instance URL helpers | Both files import from `instanceUrl.ts` |
| `mainWindow` reference | `recovery.ts` holds its own ref via `setMainWindow(win)` setter; `main.ts` calls on `createWindow()` and `closed` |
| `autoUpdater` reference | `setAutoUpdater(au)` setter on `recovery.ts`; main calls inside `initAutoUpdater()` success path |
| Quit invariant | `main.ts` exports `requestQuit()` (sets `isQuitting + app.quit()`); recovery uses callback registered via `setOnQuitRequested(cb)` |
| Tray + macOS menu | `recovery.ts` exports pure `buildTrayMenuTemplate` / `buildAppMenuTemplate`; subscriber in `main.ts` calls them and applies via `Menu.buildFromTemplate` |
| Boot-stall callback | `setOnBootStall(cb)` on `recovery.ts`; `main.ts` does not need to wire this (recovery.ts wires it to its own `enterRecoveryMode` at module load) |

### Manual Smoke Checklist

Executed before each release. See `docs/superpowers/specs/2026-05-03-electron-recovery-mode-design.md` §9 for the 14-scenario checklist (plus scenario 15 added during implementation).

---

## Notifications

`main.ts:showNotification(title, body, onClick?)` — uses Electron's `Notification` API.

- Checks `Notification.isSupported()` before showing
- `silent: false` (plays system sound)
- Click handler: defaults to show + focus the main window; an optional `onClick` parameter overrides this (used by the update-ready notification to call `autoUpdater.quitAndInstall()` directly)

Badge count: `set-badge-count` IPC calls `app.setBadgeCount()` (macOS dock badge, Windows taskbar overlay).

**Win32 attribution:** `app.setAppUserModelId('com.backspace.desktop')` set early in startup so notifications attribute to "Backspace" in Windows Action Center.

---

## Application Menu

### macOS

Full menu bar with:
- App menu: About, Change Instance, Hide/Unhide, Quit
- Edit: Undo, Redo, Cut, Copy, Paste, Select All
- Window: Minimize, Zoom, Front

### Windows/Linux

Hidden menu bar (frameless window), but an Edit menu is still registered so keyboard accelerators (Ctrl+C/V/X/Z/A) work.

---

## Screen Share Integration

The main process intercepts `getDisplayMedia()` via `session.defaultSession.setDisplayMediaRequestHandler()`.

### Flow

1. Handler invoked by Chromium when renderer calls `navigator.mediaDevices.getDisplayMedia()`
2. Main process enumerates sources via `desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true })`
3. Sources serialized (id, name, thumbnail data URL, app icon data URL, isScreen flag) and sent to renderer via `screen-share-sources` IPC
4. Renderer shows custom picker UI, user selects a source
5. Renderer sends `screen-share-selected` IPC with `sourceId` (or `null` to cancel) and `shareAudio` flag
6. Main process calls `callback({ video: selectedSource, audio: 'loopback' })` (audio only if `shareAudio` is true)

No sources (0 results) typically means Screen Recording permission not granted on macOS.

For full screen share configuration (resolution, bitrate, codec), see `voice.md`.

---

## Cache Clearing

On every app launch (`app.whenReady`), the main process purges stale caches:

```typescript
await session.defaultSession.clearStorageData({ storages: ['serviceworkers'] });
await session.defaultSession.clearCache();
```

This ensures the renderer always loads fresh code after updates.

---

## GTK Version Override

On Linux, Electron 36+ defaults to GTK 4 on GNOME, which crashes if GTK 2/3 libraries are loaded in the same process (common with uiohook-napi). The app forces GTK 3:

```typescript
app.commandLine.appendSwitch('gtk-version', '3');
```

---

## IPC Handler Registry

All handlers registered in `main.ts:registerIpcHandlers()`.

### Fire-and-Forget (`ipcMain.on`)

| Channel | Direction | Payload | Action |
|---------|-----------|---------|--------|
| `show-notification` | R->M | `{ title, body }` | Show native notification |
| `set-badge-count` | R->M | `number` | Set dock/taskbar badge |
| `minimize-window` | R->M | — | Minimize window |
| `maximize-window` | R->M | — | Toggle maximize/unmaximize |
| `close-window` | R->M | — | Close (hides to tray) |
| `install-update` | R->M | — | `quitAndInstall()` on auto-capable builds, otherwise opens the releases page. 4s watchdog flips the status to `failed` if the app is still running |
| `check-for-updates` | R->M | — | `autoUpdater.checkForUpdates()` |
| `dismiss-update` | R->M | `{ version }` | Persists the dismissal and re-pushes the snapshot |
| `open-release-page` | R->M | — | `shell.openExternal(RELEASES_URL)` |
| `screen-share-selected` | R->M | `sourceId, shareAudio?` | Safety net (actual handler is `ipcMain.once` in display media flow) |
| `keybinds-sync` | R->M | `KeybindConfig[]` | `keybindManager.updateKeybinds()` |
| `set-connected-origins` | R->M | `string[]` | Update `knownInstanceOrigins` set (used by in-instance `/join/` interception) |
| `renderer-ready` | R->M | — | Boot-completion ping; disarms boot timer |
| `recovery-action` | R->M | `RecoveryAction` enum | Recovery page button dispatcher (allowlist-validated) |

### Request/Response (`ipcMain.handle`)

| Channel | Direction | Returns | Action |
|---------|-----------|---------|--------|
| `get-instance-url` | R->M | `string \| null` | Load saved instance URL |
| `set-instance-url` | R->M | `void` | Save URL, navigate window to it |
| `clear-instance-url` | R->M | `void` | Delete saved URL, load picker |
| `get-app-version` | R->M | `string` | `app.getVersion()` |
| `get-auto-launch-settings` | R->M | `{ openAtLogin, startMinimized }` | Merge OS state with saved prefs |
| `set-auto-launch-settings` | R->M | `{ openAtLogin, startMinimized }` | Save + apply to OS |
| `get-current-activity` | R->M | `Activity \| null` | Current detected game activity |
| `check-accessibility` | R->M | `boolean` | macOS accessibility permission check |
| `get-recovery-state` | R->M | `RecoveryState` | Recovery page reads initial state on mount |
| `get-update-status` | R->M | `UpdateSnapshot` | Renderer reads the current snapshot on mount |
| `is-sandboxed` | R->M | `boolean` | Detect package sandbox restrictions independently of update capability |

### Main -> Renderer Events

| Channel | Payload | Trigger |
|---------|---------|---------|
| `window-focus-changed` | `boolean` | Window focus/blur |
| `deep-link` | `string` (URL) | `backspace://` protocol activation |
| `update-available` | `{ version }` | electron-updater |
| `update-downloaded` | `{ version }` | electron-updater |
| `update-error` | `{ message, releaseUrl }` | electron-updater (only after confirmed update) |
| `screen-share-sources` | `ElectronScreenSource[]` | Display media handler |
| `activity-detected` | `Activity \| null` | Activity detector poll |
| `keybind-action` | `{ actionId, pressed }` | KeybindManager match |
| `accessibility-status` | `{ trusted }` | macOS accessibility check result |
| `keybind-hook-error` | `{ message }` | uIOhook start failure |
| `open-internal-route` | `string` (path) | In-instance `/join/` interception: renderer navigates to `path` instead of opening externally |
| `recovery-state-changed` | `RecoveryState` | Store subscriber, mode-gated to `mode === 'recovery'` |
| `update-status-changed` | `UpdateSnapshot` | Every status or dismissal change |

---

## Preload Bridge (`window.backspace`)

The preload script exposes the `window.backspace` API via `contextBridge.exposeInMainWorld`. TypeScript declarations are in `packages/web/src/platform/electron.d.ts`.

Detection: `typeof window.backspace !== 'undefined'` (see `platform.ts:isElectron()`).

### API Surface

| Method / Property | Type | Direction | Notes |
|-------------------|------|-----------|-------|
| `platform` | `NodeJS.Platform` | read | `process.platform` value |
| `minimize()` | fire | R->M | |
| `maximize()` | fire | R->M | Toggles maximize |
| `close()` | fire | R->M | Hides to tray |
| `showNotification(title, body)` | fire | R->M | |
| `setBadgeCount(count)` | fire | R->M | |
| `onUpdateAvailable(cb)` | listen | M->R | |
| `onUpdateDownloaded(cb)` | listen | M->R | |
| `onUpdateError(cb)` | listen | M->R | |
| `installUpdate()` | fire | R->M | |
| `checkForUpdates()` | fire | R->M | |
| `getVersion()` | invoke | R->M | Returns `Promise<string>` |
| `onWindowFocusChange(cb)` | listen | M->R | |
| `onDeepLink(cb)` | listen | M->R | |
| `onScreenShareSources(cb)` | listen | M->R | |
| `selectScreenSource(id, audio?)` | fire | R->M | |
| `getInstanceUrl()` | invoke | R->M | Returns `Promise<string \| null>` |
| `setInstanceUrl(url)` | invoke | R->M | Returns `Promise<void>` |
| `clearInstanceUrl()` | invoke | R->M | Returns `Promise<void>` |
| `getAutoLaunchSettings()` | invoke | R->M | |
| `setAutoLaunchSettings(s)` | invoke | R->M | |
| `onActivityDetected(cb)` | listen | M->R | Returns cleanup function `() => void` |
| `getCurrentActivity()` | invoke | R->M | Returns `Promise<Activity \| null>` |
| `syncKeybinds(keybinds)` | fire | R->M | |
| `onKeybindAction(cb)` | listen | M->R | Returns cleanup function |
| `onAccessibilityStatus(cb)` | listen | M->R | Returns cleanup function |
| `onKeybindHookError(cb)` | listen | M->R | Returns cleanup function |
| `checkAccessibility()` | invoke | R->M | Returns `Promise<boolean>` |
| `setConnectedOrigins(origins)` | fire | R->M | Push connected-instance origin list to main (in-instance `/join/` interception) |
| `onOpenInternalRoute(cb)` | listen | M->R | Returns cleanup function; `cb` receives a path string to navigate in-app |
| `rendererReady()` | fire | R->M | Boot-completion ping; semantic: "renderer survived render" |
| `getRecoveryState()` | invoke | R->M | Returns `Promise<RecoveryState>` |
| `onRecoveryStateChanged(cb)` | listen | M->R | Returns cleanup function; recovery.html subscribes |
| `recoveryAction(action)` | fire | R->M | Single channel for all recovery button clicks |
| `getUpdateStatus()` | invoke | R->M | Returns `Promise<UpdateSnapshot>`. Optional: absent on pre-1.0.5 apps |
| `onUpdateStatusChanged(cb)` | listen | M->R | Returns cleanup function. Optional |
| `dismissUpdate(version)` | fire | R->M | Optional |
| `openReleasePage()` | fire | R->M | Optional |

The four update-snapshot methods are declared **optional** in
`electron.d.ts`. A client served by a newer instance can be running inside an
older desktop app that does not expose them, so every call site feature-detects.
`updateStore.ts` falls back to the legacy per-event channels when they are absent.

Direction legend: **fire** = `ipcRenderer.send` (no response), **invoke** = `ipcRenderer.invoke` (returns Promise), **listen** = `ipcRenderer.on` (event subscription).

---

## Activity Detection

### Overview

Detects running games/applications by polling the OS process list every 15 seconds and matching process names against a game dictionary.

### Game Dictionary

Two formats supported:

```typescript
// Legacy bare array (version 0)
GameEntry[]

// Versioned object
{ version: number; games: GameEntry[] }
```

```typescript
interface GameEntry {
  id: string;        // unique identifier, e.g. "cs2"
  name: string;      // display name, e.g. "Counter-Strike 2"
  processes: string[]; // executable names, e.g. ["cs2.exe", "cs2"]
  type?: string;     // "playing" | "listening" | "watching" | "streaming" (default: "playing")
}
```

### Dictionary Loading Strategy

1. **Startup** (`startActivityDetection`): Load best local source — cache file first (`{userData}/games-cache.json`), fall back to bundled seed (`resources/games.json`)
2. **Background sync** (`syncDictionary`): Fire-and-forget async fetch from GitHub after startup

### Remote Sync (`syncDictionary()`)

**Remote URL:** `https://raw.githubusercontent.com/TheZwiss/backspace/main/packages/desktop/resources/games.json`

```
Step 1: Determine best local version (cache vs seed, whichever has higher version)
Step 2: Fetch remote with conditional request (ETag)
Step 3: If remote version > local version → atomic write to cache, save ETag, hot-swap
```

**ETag-based conditional fetching:**
- ETag stored at `{userData}/games-cache-etag.txt`
- Sent as `If-None-Match` header; 304 response = no update needed
- Follows single redirects (301/302, common for GitHub raw)
- 10-second timeout

**Atomic file writes** (`atomicWrite()`): Writes to `{path}.tmp` then `fs.renameSync()` into place. Prevents corrupt cache on crash.

**Hot-swap** (`hotSwapDictionary()`): Replaces `gameEntries` and `processMap` in memory without resetting `currentGameId` or `currentActivity`. Active detection state survives dictionary updates.

### Process Polling

**Interval:** 15 seconds (`POLL_INTERVAL_MS`). First poll runs immediately on start.

**Guard:** `isPolling` flag prevents overlapping polls if a previous `execFile` hasn't returned.

**Error handling:** First `execFile` failure logs warning and stops detection entirely (`stopActivityDetection()`). The `hasErrored` flag prevents repeated log spam.

### Platform Commands

| Platform | Command | Output Format |
|----------|---------|---------------|
| macOS | `ps -c -A -o comm` | One process name per line (header: `COMM`) |
| Linux | `ps -A -o comm` | One process name per line (header: `COMM` or `COMMAND`) |
| Windows | `tasklist /fo csv /nh` | CSV: `"ImageName","PID","SessionName","Session#","MemUsage"` |

Max buffer: 1MB. Process names extracted and lowercased into a `Set<string>`.

### Matching Algorithm (`poll()`)

1. Parse running processes into a lowercase `Set<string>`
2. Iterate `gameEntries` in dictionary order (first match wins = priority)
3. For each entry, check if any of its `processes` (lowercased) are in the running set
4. **Game detected (new or changed):** Set `currentGameId`, build `Activity` object with `timestamps.start = Date.now()`, fire `onChangeCallback`
5. **Same game still running:** No-op (no IPC sent)
6. **Game exited (was detected, now gone):** Clear `currentGameId` and `currentActivity`, fire callback with `null`
7. **No game (and none before):** No-op

### Activity Object

```typescript
interface Activity {
  type: string;       // from GameEntry.type, default "playing"
  name: string;       // from GameEntry.name
  details?: string;   // unused currently
  state?: string;     // unused currently
  timestamps?: { start?: number; end?: number };
}
```

### Lifecycle

- **Start:** `startActivityDetection(callback)` — called from `app.whenReady()`
- **Stop:** `stopActivityDetection()` — called from `before-quit`
- **Query:** `getCurrentActivity()` — exposed via `get-current-activity` IPC handle

---

## Global Keybind Manager

### Overview

Windows, macOS and Linux X11 capture global keyboard and mouse events via
`uiohook-napi`. Linux Wayland sessions (including an XWayland app window inside
Wayland) instead use the desktop's `org.freedesktop.portal.GlobalShortcuts`
interface. An X11 hook cannot observe input to other native Wayland clients.

### Wayland portal

`globalShortcutsPortal.ts` uses a dedicated session-bus connection, registers the
desktop-file identity `io.github.TheZwiss.backspace` through the host Registry
when outside Flatpak, and creates a GlobalShortcuts session. Older portals
without the optional Registry remain supported. Flatpak supplies its own identity;
no additional bus permissions or unrestricted input-device access are requested.

The desktop is the sole source of truth for Wayland assignments. The application
registers a stable catalogue of all six voice actions, without preferred triggers
or dependence on browser/X11 keybind storage. At startup, CreateSession followed
by ListShortcuts discovers prior system registration; existing assignments are
rebound for the new session. With no prior registration, startup remains idle and
does not prompt. Opening Settings → Keybinds initiates registration of all actions.
After cancellation, only the explicit retry button can request consent again.

On Wayland the settings panel has no local recorder, edit or delete controls.
It directs users to the system's Backspace shortcut settings and shows a read-only
list of actual assignments. Closing a session unregisters its runtime listeners;
it does **not** delete the desktop's persistent shortcut configuration. Change or
remove those assignments in the desktop settings instead.

Bindings require system consent and a portal backend implementing GlobalShortcuts.
`Activated` and `Deactivated` both reach the renderer so push-to-talk works while
unfocused. Electron's press-only `globalShortcut` callback is insufficient here.
Only signals from the resolved portal owner and current session are accepted.
Repeated activations are suppressed; stop, revoked bindings, session closure,
portal restart and transport errors release held actions. Portal failure exposes
a manual retry in settings (no prompt loop). Local bindings are disabled on
Wayland even when the portal is unavailable, so a removed system assignment cannot
unexpectedly continue to work through a stale local binding.

One portal session lasts for the app run; local edits, empty configuration and
renderer unmount do not recreate it. BindShortcuts is called at most once per
session. Request responses are subscribed before method calls to handle early
replies; method and consent waits are bounded and cancelled on shutdown.

Optional preload methods `getKeybindPortalStatus`, `onKeybindPortalStatus` and
`retryKeybindPortal` report idle/pending/ready/unavailable plus actual assignments.
ShortcutsChanged triggers a full ListShortcuts refresh instead of treating the
possibly partial signal as the whole configuration. Window focus and reading
status also refresh the list, covering changes made in system settings. Removed
or reassigned held actions are released. PTT mode follows the system's active PTT
assignment, not local storage; unchanged status refreshes do not re-mute a held PTT.
Portal events bypass the legacy 100 ms duplicate filter. The browser/non-Wayland
fallback releases its own held actions on window blur and cleanup.

The MIT-licensed `dbus-next` dependency provides D-Bus message transport without a
helper executable. Its optional obsolete `usocket` native addon is excluded (no
file-descriptor transfer is needed), and `xml2js` is overridden to a patched
version. The normal filesystem session socket works through Node's built-in net
transport; legacy abstract sockets requiring the optional addon report the portal
as unavailable. Regenerate Flatpak's offline sources after lockfile changes.

### Native Keycode to DOM Code Mapping

uIOhook reports hardware scan codes. The web UI stores keybinds as djb2 hashes of DOM `KeyboardEvent.code` strings. The `UIOHOOK_TO_DOM_CODE` lookup table bridges the two.

**Mapped key ranges:**

| Category | Examples |
|----------|---------|
| Letters | A-Z (keycodes 16-50) |
| Digits | 0-9 (keycodes 2-11) |
| Function keys | F1-F24 (keycodes 59-107) |
| Modifiers | ControlLeft/Right, AltLeft/Right, ShiftLeft/Right, MetaLeft/Right |
| Special | Backspace, Tab, Enter, CapsLock, Escape, Space |
| Navigation | PageUp/Down, Home, End, Arrows, Insert, Delete |
| Punctuation | Semicolon, Equal, Comma, Minus, Period, Slash, Backquote, Brackets, Backslash, Quote |
| Numpad | Numpad0-9, NumpadMultiply/Add/Subtract/Decimal/Divide |
| Locks | NumLock, ScrollLock, PrintScreen |

### djb2 Hash Function

```typescript
function djb2(code: string): number {
  let hash = 5381;
  for (let i = 0; i < code.length; i++) {
    hash = ((hash << 5) + hash + code.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}
```

This hash is used identically in:
- `keybindManager.ts:djb2()` — main process, matching against native events
- `useKeybinds.ts:browserCodeToUiohook()` — renderer, web fallback path
- `KeybindsPanel.tsx:codeToNumeric()` — renderer, recording keybinds in settings UI

The pre-computed `UIOHOOK_TO_HASH` map converts uIOhook keycodes directly to djb2 hashes at module load time.

### KeybindConfig

```typescript
interface KeybindConfig {
  actionId: string;      // e.g. "toggleMute", "pushToTalk"
  keys: number[];        // djb2 hashes of DOM code strings
  mouseButton?: number;  // uIOhook mouse button index (3=middle, 4=back, 5=forward)
}
```

### KeybindManager Class

**State:**
- `keybinds: KeybindConfig[]` — current bindings synced from renderer
- `pressedKeys: Set<number>` — currently held keys (djb2 hashes)
- `activeActions: Set<string>` — actions whose keybind is currently satisfied
- `window: BrowserWindow | null` — target for IPC sends
- `started: boolean` — whether uIOhook is running

### Lifecycle

1. **`updateKeybinds(keybinds)`** — called when renderer syncs new bindings via `keybinds-sync` IPC
   - Replaces stored keybinds
   - Releases any active actions whose binding was removed
   - Auto-starts uIOhook if keybinds exist and hook not running
   - Auto-stops uIOhook if keybinds list becomes empty

2. **`start()`** — registers uIOhook event listeners and calls `uIOhook.start()`
   - On macOS: checks `systemPreferences.isTrustedAccessibilityClient(true)` first (the `true` parameter triggers the OS permission prompt)
   - If not trusted: sends `accessibility-status` event to renderer and returns without starting
   - On start failure: sends `keybind-hook-error` to renderer

3. **`stop()`** — releases all active actions, clears state, removes listeners, calls `uIOhook.stop()`
   - Called from `app.on('before-quit')`

### Event Processing

**Key down (`onKeyDown`):**
1. Convert uIOhook keycode to djb2 hash via `UIOHOOK_TO_HASH`
2. Add hash to `pressedKeys`
3. `evaluateKeybinds()`: for each keybind (no mouseButton, not already active), check if all `keys` are in `pressedKeys` → if yes, activate and send `pressed: true`

**Key up (`onKeyUp`):**
1. Convert keycode to hash, remove from `pressedKeys`
2. `checkReleases()`: for each active action (no mouseButton), check if any required key is no longer pressed → if so, deactivate and send `pressed: false`

**Mouse down (`onMouseDown`):**
1. Ignore buttons 1 (left) and 2 (right) — only extra buttons (3+) are bindable
2. `evaluateKeybindsWithMouse(button)`: for keybinds matching this mouseButton that aren't already active, check modifier keys → activate

**Mouse up (`onMouseUp`):**
1. Ignore buttons 1 and 2
2. `checkMouseReleases(button)`: deactivate actions bound to this mouse button

### IPC Output

All matched actions sent to renderer as: `keybind-action { actionId: string, pressed: boolean }`

This is critical for **push-to-talk**: the `pressed: true` unmutes, `pressed: false` re-mutes. Toggle actions (mute, deafen, camera, etc.) only trigger on `pressed: true`.

### macOS Accessibility Permission

uIOhook requires Accessibility permission on macOS to capture global input events.

| Method | `prompt` param | Effect |
|--------|---------------|--------|
| `start()` → `isTrustedAccessibilityClient(true)` | true | Checks + shows OS permission dialog if not trusted |
| `checkAccessibility()` → `isTrustedAccessibilityClient(false)` | false | Checks without prompting |

On non-macOS platforms, `checkAccessibility()` always returns `true`.

---

## Keybind System (Web Side)

### Keybind Store (`keybindStore.ts`)

Persisted via Zustand `persist` middleware to `localStorage` key `backspace-keybinds` (version 1).

```typescript
interface Keybind {
  actionId: string;
  keys: number[];          // djb2 hashes, sorted ascending
  mouseButton?: number;    // 3=middle, 4=back, 5=forward
  displayLabel: string;    // human-readable, captured at record time
}
```

**Blacklisted mouse buttons:** 1 (left), 2 (right) — `setKeybind()` silently ignores these.

**Conflict detection:** `findConflict(keys, mouseButton?, excludeActionId?)` checks for exact key+mouse match against existing bindings.

### Bindable Actions

| Action ID | Label | Type |
|-----------|-------|------|
| `toggleMute` | Toggle Mute | toggle |
| `toggleDeafen` | Toggle Deafen | toggle |
| `pushToTalk` | Push to Talk | hold |
| `toggleCamera` | Toggle Camera | toggle |
| `toggleScreenShare` | Toggle Screen Share | toggle |
| `disconnect` | Disconnect | toggle |

### useKeybinds Hook

Three parallel systems:

**1. PTT Lifecycle** — When `pushToTalk` keybind exists and user is in voice: activates PTT mode (`pttActive: true`), force-mutes the user. Deactivates when keybind removed or user leaves voice.

**2. Electron IPC Bridge** — Active when `isElectron()` and keybinds exist:
- Syncs keybind config to main process via `syncKeybinds()`
- Subscribes to `onKeybindAction()` for matched events from uIOhook
- Cleanup on unmount

**3. Web Fallback** — Always active (both web and Electron):
- Capture-phase `keydown`/`keyup`/`mousedown`/`mouseup` listeners on `window`
- Converts `KeyboardEvent.code` to djb2 hash via inline `browserCodeToUiohook()`
- Same evaluation logic as KeybindManager (track pressed keys, match keybinds, detect releases)
- **Input suppression:** Skips single character keys (no modifiers) when an input/textarea/contentEditable is focused
- **Mouse button mapping:** Browser button index -> uIOhook: `{ 1: 3, 3: 4, 4: 5 }` (middle, back, forward)

**Deduplication:** `dispatchKeybindAction()` uses a 100ms cooldown per `actionId:pressed` pair to prevent double-firing when both the native hook and web fallback trigger simultaneously (common when the Electron window is focused).

### Action Dispatch (`dispatchKeybindAction()`)

Only dispatches when user is in a voice channel (`currentVoiceChannelId` exists).

Checks space mute/deafen enforcement state before dispatching mute/deafen actions (see `voice.md` for voice moderation details).

| Action | Trigger | Behavior |
|--------|---------|----------|
| `toggleMute` | `pressed: true` | `handleMuteAction()` (respects space enforcement) |
| `toggleDeafen` | `pressed: true` | `handleDeafenAction()` |
| `toggleCamera` | `pressed: true` | `handleCameraAction()` |
| `toggleScreenShare` | `pressed: true` | `handleScreenShareAction()` |
| `disconnect` | `pressed: true` | `handleDisconnectAction()` |
| `pushToTalk` | `pressed: true/false` | `setMuted(!pressed)` + `broadcastVoiceStatus()` |

Toggle actions only fire on `pressed: true`. Push-to-talk fires on both press (unmute) and release (mute).

---

## Build System

### electron-builder Configuration (`electron-builder.yml`)

```yaml
appId: com.backspace.desktop
productName: Backspace
artifactName: "${productName}-${version}-${arch}.${ext}"
output: dist-electron
```

### Build Targets

| Platform | Formats |
|----------|---------|
| macOS | dmg, zip |
| Windows | nsis (allows custom install dir) |
| Linux | AppImage, deb |

### Build Commands

| Command | Description |
|---------|-------------|
| `pnpm build` | TypeScript compile + electron-builder (current platform) |
| `pnpm build:all` | Cross-platform: `--mac --win --linux --arm64 --x64` |
| `pnpm dev` | Compile TypeScript + launch Electron (with icon setup) |

### Native Module Handling

**Dependency:** `uiohook-napi` (native N-API addon for global input hooks)

**Rebuild:** `electron-rebuild -f -w uiohook-napi` runs on `postinstall` to compile for the build machine's Electron ABI. `uiohook-napi` is the only native module this rebuild touches, and it is the only one in the desktop dependency tree. `better-sqlite3` belongs to `packages/server` and never enters the packaged app, so an Electron ABI mismatch cannot reach it.

`@electron/rebuild` 4 is ESM-only and declares `engines.node: >=22.12.0`, while `release.yml` and one leg of `ci.yml` run Node 20. Measured on Node 20.19.5, the CLI loads and completes the rebuild anyway: it uses `parseArgs`, `styleText` and `import.meta.dirname`, all of which exist in 20.19. The `postinstall` also ends in `|| node -e "console.warn(...)"`, so a future failure degrades to a warning rather than breaking `pnpm install`. That fallback is what makes the engines mismatch tolerable, not the measurement: if the rebuild ever does stop running on Node 20, `pnpm dev` breaks locally while release builds keep working, because packaging uses `prebuilds/` and `npmRebuild: false`.

**ASAR unpacking:** All `.node` files are unpacked from the ASAR archive (`asarUnpack: "**/*.node"`). Native modules cannot load from inside ASAR.

**Build exclusions:** Host-compiled artifacts are excluded from the ASAR to prevent them from shadowing platform-correct prebuilts:
```yaml
- "!**/node_modules/uiohook-napi/build/**"
- "!**/node_modules/uiohook-napi/build.bak/**"
- "!**/node_modules/uiohook-napi/bin/**"
```

`npmRebuild: false` — electron-builder's built-in rebuild is disabled; the `postinstall` script handles it.

### afterPack Hook (CRITICAL)

**File:** `scripts/afterPack.js`

**Problem:** `electron-rebuild` (postinstall) compiles `uiohook-napi` for the BUILD machine (e.g., macOS arm64), placing the binary in `build/Release/`. The `node-gyp-build` loader checks `build/Release/` BEFORE `prebuilds/{platform}/`. Without cleanup, cross-platform builds (e.g., building Windows packages on macOS) would ship the macOS binary, causing immediate crashes on the target platform.

**Solution (two steps):**

1. **Remove host-compiled artifacts:** Deletes `build/`, `build.bak/`, and `bin/` directories from the unpacked `uiohook-napi` in the output.

2. **Strip foreign prebuilts:** Removes `prebuilds/{platform}-{arch}/` directories for platforms other than the build target. Saves ~1-2MB per build.

**Path resolution:** On macOS, resources live inside `{productName}.app/Contents/Resources/`; on Windows/Linux, under `resources/`. The hook resolves the correct path via `context.electronPlatformName`.

**WARNING:** Removing or disabling this hook will cause Windows and Linux builds to crash on launch. This is documented in project memory as a critical constraint.

3. **Ad-hoc sign (macOS only):** Delegates to `scripts/macSign.js`. Must run last — signing seals the bundle, so it has to follow every file mutation, including the deletions above.

### macOS Ad-hoc Signing (CRITICAL)

**File:** `scripts/macSign.js`

**Problem:** electron-builder only signs when it can resolve a signing identity. With no Developer ID available, `MacPackager.sign()` bails out before signing at all (`findIdentity()` → `null` → `reportError()` → `return false`), leaving the bundle with only the linker-generated ad-hoc signatures baked into the prebuilt Electron binaries. Packaging then invalidates those: it renames the executable, rewrites `Info.plist`, injects `app.asar`, and deletes files from `Contents/Resources`.

The result is not merely unsigned, it is **invalid** — `codesign --verify` reports `code has no resources but signature indicates they must be present`, and there is no `Contents/_CodeSignature` at all. macOS reports an invalid signature as *"Backspace.app is damaged and can't be opened. You should move it to the Trash."* That is a dead end: unlike the unnotarized-app warning, it offers no "Open Anyway" path. Every macOS user of v1.0.0 hit this (issue #38).

**Solution:** Re-seal the bundle with an ad-hoc signature in `afterPack`:

1. Sign every Mach-O under `Contents/Resources` (`.node`, `.dylib`). `codesign --deep` only reaches the standard nested-code locations, so native modules unpacked to `app.asar.unpacked` are otherwise sealed as plain resources and never signed.
2. `codesign --force --deep --sign -` the bundle. `--deep` is discouraged for distribution signing because it applies one entitlement set to every nested binary; ad-hoc signatures carry no entitlements, so that does not apply here.
3. `codesign --verify --deep --strict` immediately, so a bad bundle fails the build **before** electron-builder packages and publishes it. `.github/workflows/release.yml` re-checks the final bundle as a backstop.

**Why `afterPack` and not `afterSign`:** electron-builder skips the `afterSign` hook entirely when no signing occurred (`didSign === false`), which is precisely this build's situation.

**No-op conditions:** skips when `CSC_LINK` or `CSC_NAME` is set, so a real Developer ID identity takes over cleanly, and warns (rather than failing) on non-macOS hosts, which cannot run `codesign`.

**WARNING:** Removing this hook makes macOS builds refuse to launch entirely.

### Icon Generation

All desktop and web brand assets are generated by `scripts/gen-icons.mjs` from sources in `assets/brand/`. Run via `pnpm gen-icons` after artwork changes; commit the diff. The generator uses `sharp` (resize / SVG → PNG / squircle composite), `png-to-ico` (multi-size `.ico`), and `png2icons` (`.icns`). Output is byte-stable for a given lockfile.

**Sources:**
- `app-icon.svg` — flat-vector B-badge. Drives app-icon outputs <128 px (favicons, small `.ico` reps, small Linux launcher reps) where pixel-grid alignment beats 3D detail.
- `app-icon-x1.png` (149) / `app-icon-x2.png` (294) / `app-icon-x3.png` (440) / `app-icon-1024.png` (1024) — 3D-rendered B-badge at four native resolutions. Drives app-icon outputs ≥128 px (PWA, dock, launcher, homescreen, in-app sidebar logo). The generator picks the smallest source whose dimension is ≥ the target output size, so every output is a downscale (no upscale anywhere). After resize, a 22 %-radius rounded-square mask clips the corners to transparent — matches Apple's macOS template ratio and the existing `app-icon.svg` geometry, so launchers/docks/homescreens that render the icon as-is produce the rounded silhouette they expect.
- `mark.svg` — bare gradient B. Drives the PWA maskable inner (60 % scale on `#1d1d1b`) and the Win/Linux tray icons.
- `mark-mono-dark.svg` — solid-black B. Drives the macOS menu-bar template tray icon (alpha + black; OS recolours).

The `dev` script copies the committed `build/icon.icns` into Electron's bundled `Resources/electron.icns` so the macOS dev dock shows the Backspace mark instead of the default Electron logo. This dev-only patch is independent of how `.icns` is generated.

See `scripts/gen-icons.README.md` for the regeneration workflow and version-bump caveat (sharp / png-to-ico / png2icons upgrades change encoder output, requiring a follow-up regen+commit).

### Auto-Update Publishing

```yaml
publish:
  - provider: github
    owner: TheZwiss
    repo: backspace
```

GitHub releases are the update source. The `electron-updater` library handles checking, downloading, and applying updates.

---

## Persisted Files (userData)

### userData Folder Location

The runtime userData folder is named `Backspace` on every platform:

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/Backspace/` |
| Linux | `~/.config/Backspace/` |
| Windows | `%APPDATA%\Backspace\` |

Electron's default `app.getName()` reads `package.json`'s `name`, which in this monorepo is `@backspace/desktop` — that would land userData under a nested `@backspace/desktop/` folder. To prevent the monorepo's internal package name from leaking into a user-facing filesystem path, `main.ts` calls `app.setName('Backspace')` at module load, before any `app.getPath('userData')` consumer runs. electron-builder's `productName: Backspace` only renames the bundle metadata (`Backspace.app`, executable, installer, app menu) — it does not affect runtime userData.

### One-Time Migration

Earlier builds wrote to `<appData>/@backspace/desktop/`. On first launch after the rename, `migrateUserData()` (in `userDataMigration.ts`) atomically moves that folder to `<appData>/Backspace/` and removes the now-empty `@backspace/` parent. The migration is conservative: if the new folder already exists and is non-empty, it skips the move rather than clobbering existing state. Failures are logged, not thrown — a failed migration leaves the user with a fresh-install state, which is degraded but not broken.

### Files

| File | Content | Purpose |
|------|---------|---------|
| `instance-url.json` | `{ url: string }` | Saved instance URL |
| `window-state.json` | `WindowState` | Window position, size, maximize state |
| `auto-launch.json` | `AutoLaunchSettings` | Open at login + start minimized prefs |
| `update-state.json` | `{ dismissedVersion }` | The update version the user waved away. Belongs to the app, not to an instance |
| `games-cache.json` | `VersionedDictionary` | Cached remote game dictionary |
| `games-cache-etag.txt` | ETag string | For conditional HTTP requests |

---

## App Lifecycle Summary

### Startup Sequence (`app.whenReady()`)

1. Set application menu (platform-specific)
2. Clear service worker cache + HTTP cache
3. Register `setDisplayMediaRequestHandler` for screen share
4. Register all IPC handlers
5. Create main window (with state restoration)
   - After the BrowserWindow is constructed, `setMainWindow(mainWindow)` and `attachRecoveryHandlers(mainWindow)` are called. The `closed` event handler calls `setMainWindow(null)`.
6. Create tray icon
7. Resolve the update capability, then initialize the auto-updater (10s delayed
   first check). An `external` capability, including Flatpak, records that state
   without loading `electron-updater`.
8. Wire recovery store subscriber (rebuilds tray + macOS menu on every state change; pushes `recovery-state-changed` to renderer when in recovery mode)
9. `setOnQuitRequested(requestQuit)` so recovery's Quit button uses the same `isQuitting + app.quit()` pattern as the tray
10. Start activity detection (immediate first poll, 15s interval, background
    remote sync). Flatpak uses the same platform-dependent behavior as global
    keybinds instead of applying a contradictory package-wide disable.
11. Linux/AppImage path-refresh: re-apply autostart entry if `$APPIMAGE` path changed (conditional; no-op on Windows/macOS)
12. Check for deep link in launch args

### Shutdown Sequence (`before-quit`)

1. Set `isQuitting = true` (allows window close to proceed)
2. Stop activity detection (clear interval, null callback)
3. Stop keybind manager (release active actions, stop uIOhook)

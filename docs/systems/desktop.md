# Desktop & Electron System

Source files:
- `packages/desktop/src/main.ts` — Main process: window management, tray, IPC handlers, auto-update, deep links, app lifecycle
- `packages/desktop/src/preload.ts` — Context bridge: exposes `window.backspace` API to renderer
- `packages/desktop/src/activityDetector.ts` — Process polling, game dictionary loading/sync, activity change detection
- `packages/desktop/src/keybindManager.ts` — Global keybinds via uIOhook, native keycode mapping, press/release tracking
- `packages/web/src/stores/keybindStore.ts` — Client-side keybind persistence (Zustand + localStorage)
- `packages/web/src/hooks/useKeybinds.ts` — Keybind dispatch: Electron IPC bridge + web capture-phase fallback
- `packages/web/src/platform/electron.d.ts` — TypeScript declarations for `window.backspace`
- `packages/web/src/platform/platform.ts` — `isElectron()` / `isElectronMac()` / `getElectronAPI()` helpers
- `packages/desktop/electron-builder.yml` — Build config, protocol registration, afterPack hook
- `packages/desktop/scripts/afterPack.js` — Cross-platform native module cleanup (critical for builds)
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

Powered by `electron-updater`. Loaded via `require()` (not import) for graceful degradation when not available.

### Configuration (`initAutoUpdater()`)

```
autoDownload: true
autoInstallOnAppQuit: true
Publish: GitHub (TheZwiss/backspace)
```

**Signing status (as of v1.0.0):** all builds are unsigned. Consequences:
- **macOS:** Squirrel.Mac refuses to apply unsigned updates — auto-update is
  effectively disabled on macOS until a Developer ID certificate + notarization
  are added to the CI build. Users update manually from the releases page.
  First launch requires right-click → Open (Gatekeeper).
- **Windows:** NSIS auto-update works unsigned; SmartScreen warns on first
  install only.
- **Linux:** AppImage auto-update works unsigned.

CI publishes via `.github/workflows/release.yml` (tag `v*` on the public repo):
native runners for mac (arm64+x64), win (x64+arm64), linux (x64, arm64), each
job uploading its installers, `.blockmap`s, and platform `latest*.yml` manifest
to a single draft release. The draft must be published manually — drafts are
invisible to electron-updater.

### Check Schedule

| Trigger | Delay |
|---------|-------|
| Initial check | 10 seconds after app ready |
| Periodic check | Every 4 hours |
| Manual check | `check-for-updates` IPC from renderer |

### Event Flow (main -> renderer)

| Event | IPC Channel | Payload | Condition |
|-------|------------|---------|-----------|
| Update found | `update-available` | `{ version }` | Always |
| Download complete | `update-downloaded` | `{ version }` | Always |
| Error | `update-error` | `{ message, releaseUrl }` | Only if `updateConfirmed` is true (download failed after update was confirmed) |

Check-phase errors (network, auth, 404) are silently ignored — nothing actionable for the user.

### Install

`install-update` IPC triggers `autoUpdater.quitAndInstall()`.

### Recovery Integration

All `autoUpdater` events update the `RecoveryStateStore` (drives tray + macOS menu UI dynamically). Existing renderer IPC channels (`update-available`, `update-downloaded`, `update-error`) are preserved unchanged.

On `update-downloaded`, a native OS notification fires **only when `mainWindow?.isFocused()` is false** — symmetric suppression across normal and recovery modes (the in-app banner / Restart button is visible to a focused user; the notification covers minimized/tray/background-desktop cases). Notification click calls `autoUpdater.quitAndInstall()` directly (force-kill fix path — see Recovery Mode section).

Win32 only: `app.setAppUserModelId('com.backspace.desktop')` is set early in startup so notifications attribute to "Backspace" instead of "Electron" in Windows Action Center.

`extractErrorCode(err)` in `recovery.ts` extracts the `code` field from `electron-updater` errors when present (string only); used to populate `RecoveryState.lastUpdateError.code`.

---

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
  updateState: 'idle' | 'checking' | 'downloading' | 'downloaded' | 'error';
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
| Check for Updates | always | not in `'checking'` / `'downloading'` / `'downloaded'` |
| Change Instance | always | always |
| Open Releases Page | `updateState === 'error'` | always when visible |
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
| `install-update` | R->M | — | `autoUpdater.quitAndInstall()` |
| `check-for-updates` | R->M | — | `autoUpdater.checkForUpdates()` |
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

Captures global keyboard and mouse events via `uiohook-napi` (OS-level input hook) and matches them against user-configured keybinds. Works even when the Backspace window is not focused.

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

**Rebuild:** `electron-rebuild -f -w uiohook-napi` runs on `postinstall` to compile for the build machine's Electron ABI.

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
7. Initialize auto-updater (10s delayed first check)
8. Wire recovery store subscriber (rebuilds tray + macOS menu on every state change; pushes `recovery-state-changed` to renderer when in recovery mode)
9. `setOnQuitRequested(requestQuit)` so recovery's Quit button uses the same `isQuitting + app.quit()` pattern as the tray
10. Start activity detection (immediate first poll, 15s interval, background remote sync)
11. Linux/AppImage path-refresh: re-apply autostart entry if `$APPIMAGE` path changed (conditional; no-op on Windows/macOS)
12. Check for deep link in launch args

### Shutdown Sequence (`before-quit`)

1. Set `isQuitting = true` (allows window close to proceed)
2. Stop activity detection (clear interval, null callback)
3. Stop keybind manager (release active actions, stop uIOhook)

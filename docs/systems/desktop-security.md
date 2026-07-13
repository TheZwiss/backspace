# Desktop Security (Electron Hardening)

Source files:
- `packages/desktop/src/main.ts` — `BrowserWindow` webPreferences, `will-navigate` deny handler, `setWindowOpenHandler`
- `packages/desktop/src/navigationPolicy.ts` — pure `will-navigate` allow/deny decision logic (unit-tested)
- `packages/desktop/scripts/afterPack.js` — native-module cleanup + Electron fuse-flipping (electron-builder's single `afterPack` hook)
- `packages/desktop/electron-builder.yml` — build config; `asarUnpack`, `afterPack` wiring
- `.github/workflows/release.yml` — release build matrix; currently unsigned (`CSC_IDENTITY_AUTO_DISCOVERY: "false"`)

---

## webPreferences posture

`main.ts`'s `createWindow()` constructs the single `BrowserWindow` with:

| Setting | Value | Effect |
|---|---|---|
| `contextIsolation` | `true` | Renderer JS runs in an isolated context from the preload script's privileged APIs; the renderer cannot reach into `window.backspace`'s implementation or Node internals directly. |
| `nodeIntegration` | `false` | The renderer has no direct access to Node.js globals (`require`, `process`, `fs`, ...). |
| `sandbox` | `true` | The renderer process runs inside Electron's OS-level sandbox (Chromium's sandbox), matching Chrome's own security model for untrusted web content. |

This matters because the renderer loads a remote, federated, user-facing web app (arbitrary chat content, embeds, and — for federation — content served by third-party Backspace instances the user has connected to). The renderer is treated as untrusted; all privileged operations (notifications, tray, window controls, keybinds, auto-update) go through the `contextBridge`-exposed `window.backspace` API in `preload.ts`, never through direct Node/Electron access.

## Electron fuses

Three fuses are flipped on every packaged build (`RunAsNode`, `EnableNodeCliInspectArguments`, `OnlyLoadAppFromAsar`), via `@electron/fuses`' `flipFuses()` called from `scripts/afterPack.js` (electron-builder's single `afterPack` hook). This is *not* done via electron-builder's top-level `electronFuses:` config key — the installed electron-builder (`^25.1.8`) predates that feature (verified by exhaustively grepping the installed `app-builder-lib` package for any fuse-related code: zero hits; electron-builder's newer upstream source implements it in `platformPackager.ts`, which this installed version does not have). If electron-builder is ever upgraded past the version that adds `electronFuses:` support, that top-level key becomes the preferred mechanism and this `afterPack.js` logic should move there — but only if doing so doesn't require a second `afterPack` hook (electron-builder only allows one).

| Fuse | State | Why |
|---|---|---|
| `RunAsNode` | Disabled | Prevents `ELECTRON_RUN_AS_NODE=1 ./Backspace` (or an equivalent env var) from turning the packaged binary into an arbitrary Node.js code execution vector. This codebase never sets that env var or calls `process.fork()` on itself, so disabling it has no functional impact. |
| `EnableNodeCliInspectArguments` | Disabled | Prevents `--inspect`/`--inspect-brk` from attaching a debugger to a running instance, which would otherwise let a local attacker read/write the main process's memory and call any Electron/Node API it has access to. |
| `OnlyLoadAppFromAsar` | Enabled | Electron will only load application code from `app.asar`, refusing to load from a sibling unpacked directory an attacker could plant. Compatible with the existing `asarUnpack: **/*.node` config: that setting unpacks native `.node` addons only, which are loaded via Node's own `dlopen`, not Electron's asar-aware app-code loader — `OnlyLoadAppFromAsar` does not affect them. |

Inspect a packaged build's fuse states with:
```bash
pnpm --filter @backspace/desktop exec electron-fuses read --app /path/to/Backspace.app
```

`@electron/fuses` is pinned to `^1.8.0`, not the current npm-"latest" `2.x` line — `2.x` (`2.0.0`+) requires Node `>=22.12.0` and is ESM-only (no `require()` support), which is incompatible with this repo's Node 20 pin (`package.json` `engines.node`, and `release.yml`'s `node-version: 20`). `1.8.0` is the last plain-CommonJS release with no Node-version floor beyond what this repo already requires, and its `flipFuses`/`FuseVersion`/`FuseV1Options` API is unchanged from the `2.x` line.

## Asar integrity — what's NOT enabled, and why

`@electron/fuses` also offers `EnableEmbeddedAsarIntegrityValidation`, which makes Electron hash-check `app.asar`'s header against a value embedded in the packaged app (on macOS, in `Info.plist` under an `ElectronAsarIntegrity` key) before loading it. **This fuse is intentionally NOT enabled.**

Why:
- Flipping it is not sufficient on its own — electron-builder (or a custom afterPack step) must also *compute and inject* the correct hash into `Info.plist`. The installed electron-builder (25.1.8) does not automate this (same version gap as the `electronFuses:` config key above). Building this injection step correctly and testing it was out of scope for this plan.
- If the fuse is enabled without the matching hash being present/correct, Electron **fails closed**: the app refuses to launch entirely. Given this codebase's release pipeline is unsigned (see below), shipping a broken launch path was judged a worse outcome than the marginal protection this fuse adds today.
- **Even if wired up correctly, its protection is limited without real code signing.** The hash lives in `Info.plist`, which is itself just a file inside the (unsigned) `.app` bundle — an attacker capable of modifying `app.asar` on disk is equally capable of recomputing the hash and rewriting `Info.plist` to match, unless the outer bundle is code-signed (so the OS's own signature verification detects *any* modification, including to `Info.plist`). Asar integrity validation is meant to complement code signing, not substitute for it.

**Follow-up (gated on real code signing, see below):** once macOS code signing is in place, revisit adding `EnableEmbeddedAsarIntegrityValidation` with correct `Info.plist` hash injection in `afterPack.js`, and re-verify the packaged app still launches (per Task 3's boot-test pattern) before shipping it.

## `will-navigate` deny handler

`main.ts` attaches a `will-navigate` listener to the main window's `webContents` (see `createWindow()`, right after the existing `setWindowOpenHandler`). Its decision logic lives in `navigationPolicy.ts`'s `isNavigationAllowed()`, which is unit-tested independently of Electron.

**Mechanism:** Electron's `will-navigate` event fires only for page/user-initiated top-level navigation — a clicked link, a `window.location` assignment from renderer JS, a meta-refresh. It does **not** fire for main-process-initiated `webContents.loadURL()` / `loadFile()` / `back()` / `forward()` calls. This app's three legitimate top-level navigation paths are all main-process calls:
- The initial instance load (`BACKSPACE_URL` env var or a saved instance URL) — `loadURL()`.
- The `file://` instance picker (no saved/env instance) — `loadFile()`.
- Cross-instance switching (`set-instance-url` IPC handler) and disconnecting back to the picker (`clear-instance-url` IPC handler) — both `loadURL()`/`loadFile()`.

None of these ever reach the `will-navigate` handler, so the deny handler adds no risk to any of them. It exists as defense-in-depth: if a compromised or malicious renderer (e.g. via a federated instance serving hostile content, or a supply-chain-compromised dependency in the web bundle) tries to hijack the top-level frame with `window.location = 'https://attacker.example/'`, the handler blocks it. The allowlist is:
1. Same-origin as the window's current URL (normal in-app navigation).
2. The bundled instance-picker `file://` URL exactly (not `file://` generally — an attacker-controlled `file://` navigation to an arbitrary local path is still blocked).
3. A known federation-peer/own-instance origin (the same `knownInstanceOrigins` set `setWindowOpenHandler` already uses, kept in sync by the renderer via the `set-connected-origins` IPC message).

Anything else is denied (`event.preventDefault()`) and logged as a warning in the main process's console.

`setWindowOpenHandler` (`main.ts:454-470`) is unrelated and unchanged by this — it governs `window.open()`/new-window requests (used for `/join/*` deep-link interception and external-link handling), not same-window top-level navigation.

## Code signing & notarization — NOT done, exact steps to procure

Desktop release builds are currently **unsigned**: `.github/workflows/release.yml` sets `CSC_IDENTITY_AUTO_DISCOVERY: "false"` for every platform in the release matrix, and there is no notarization step. This is a deliberate, previously-accepted gap this plan does not close (procuring certificates is a real-money, real-identity action outside what can be done in code) — it is documented here so a maintainer can execute it later without re-deriving the steps.

### macOS: Apple Developer ID + notarization

1. **Procure an Apple Developer Program membership** (~$99/year) at https://developer.apple.com/programs/. Requires a real Apple ID and (for an org) a D-U-N-S number.
2. **Generate a "Developer ID Application" certificate** via Xcode (Settings → Accounts → Manage Certificates → +) or the Apple Developer portal (Certificates → + → Developer ID Application). Export it as a `.p12` file with a password.
3. **Base64-encode the `.p12`** and store it as a GitHub Actions secret (e.g. `MACOS_CERTIFICATE`), plus the export password as `MACOS_CERTIFICATE_PWD`.
4. **Create an App Store Connect API key** (or use an app-specific password) for notarization: App Store Connect → Users and Access → Integrations → App Store Connect API → generate a key with the "Developer" role. Store the key ID, issuer ID, and the `.p8` key content as secrets (e.g. `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`).
5. **In `release.yml`'s macOS job**, replace `CSC_IDENTITY_AUTO_DISCOVERY: "false"` with the real signing identity env vars electron-builder expects (`CSC_LINK` pointing at the decoded `.p12`, `CSC_KEY_PASSWORD`), and add electron-builder's notarization config (`mac.notarize` in `electron-builder.yml`, or the `afterSign` hook pattern electron-builder documents) referencing the App Store Connect API key secrets from step 4.
6. **Verify** with `codesign --verify --deep --strict` and `spctl -a -vv` against a built `.app`, and `xcrun notarytool history` to confirm the notarization ticket was issued, before shipping to users.

### Windows: code-signing certificate

1. **Procure a code-signing certificate** from a CA in Microsoft's trusted list (e.g. DigiCert, Sectigo) — either an OV certificate (~$300-500/year, subject to a SmartScreen reputation ramp-up) or an EV certificate (~$300-600/year, immediate SmartScreen trust, requires a hardware token or cloud HSM such as Azure Key Vault / SignPath).
2. **Store the certificate** as a GitHub Actions secret. For an EV cert on a hardware token, a cloud HSM signing service (e.g. Azure Trusted Signing, SignPath.io) is the practical path for CI — a physical USB token can't be plugged into a GitHub-hosted runner.
3. **In `release.yml`'s Windows job**, set `CSC_LINK`/`CSC_KEY_PASSWORD` (traditional cert) or wire electron-builder's `win.signtoolOptions`/custom sign hook (HSM-backed signing) per whichever provider is chosen.
4. **Verify** with `signtool verify /pa` against a built `.exe`/NSIS installer before shipping.

### Linux

AppImage/`.deb` distribution does not require a paid certificate; Linux package managers rely on repository-level trust (e.g. a GPG-signed apt repo) rather than binary code signing. If Backspace ever ships via a `.deb` apt repository, GPG-sign the repository metadata — this is a separate, lower-priority item from macOS/Windows signing and is not detailed further here.

### Known gap: unsigned auto-update

`electron-updater`'s GitHub provider (configured in `electron-builder.yml`'s `publish:` block) downloads and installs updates without a code-signature check on macOS/Windows today, because there is no signature to check — the app is unsigned. Once code signing (above) is wired up, `electron-updater` will additionally verify the new update package's signature before install, closing a real risk: today, a compromised GitHub release (or a MITM on an unpatched update channel — though GitHub Releases are served over HTTPS) could ship a malicious update that installs without any signature mismatch to alert the user. This is flagged as a known gap, not fixed by this plan.

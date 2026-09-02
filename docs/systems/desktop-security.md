# Desktop Security (Electron Hardening)

Source files:
- `packages/desktop/src/main.ts` — `BrowserWindow` webPreferences, `will-navigate` deny handler, `setWindowOpenHandler`
- `packages/desktop/src/navigationPolicy.ts` — pure `will-navigate` allow/deny decision logic (unit-tested)
- `packages/desktop/scripts/afterPack.js` — native-module cleanup, then Electron fuse-flipping, then (on macOS) ad-hoc signing, in that order (electron-builder's single `afterPack` hook)
- `packages/desktop/scripts/macSign.js` — macOS ad-hoc `codesign` fallback, called last from `afterPack.js`; stands aside when a real signing identity is configured
- `packages/desktop/electron-builder.yml` — build config; `asarUnpack`, `afterPack` wiring
- `.github/workflows/release.yml` — release build matrix; sets `CSC_IDENTITY_AUTO_DISCOVERY: "false"` for every platform, which stops electron-builder from searching the runner's keychain for a signing identity. That disables identity *discovery*, which is not the same as not signing at all: macOS bundles are still ad-hoc signed by `macSign.js`, while Windows and Linux artifacts ship unsigned. The workflow also re-checks the final macOS `.app` with `codesign --verify --deep --strict` after the build.

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

Three fuses are flipped on every packaged build (`RunAsNode`, `EnableNodeCliInspectArguments`, `OnlyLoadAppFromAsar`), via `@electron/fuses`' `flipFuses()` called from `scripts/afterPack.js` (electron-builder's single `afterPack` hook). This is *not* done via electron-builder's top-level `electronFuses:` config key.

The reason changed with electron-builder 26. Under `^25.1.8` the key did not exist: grepping the installed `app-builder-lib` for fuse-related code returned zero hits, and `app-builder-lib@25.1.8`'s dependencies do not include `@electron/fuses` at all. Under `^26.15.3` the key does exist. `app-builder-lib@26.15.3` declares `@electron/fuses@^1.8.0` as a dependency, `configuration.d.ts` declares `readonly electronFuses?: FuseOptionsV1 | null`, and `platformPackager.js` reads it in `doAddElectronFuses()`.

The hand-rolled hook stays anyway, for a reason specific to this pipeline. `platformPackager.js` calls `doAddElectronFuses()` *after* `emitAfterPack()` and immediately before signing, with the comment "the fuses MUST be flipped right before signing". Here `afterPack.js` is also where `macSign.js` ad-hoc seals the macOS bundle, so electron-builder's own flip would rewrite the Electron binary after that seal and invalidate it. Moving to the config key therefore means dropping the ad-hoc signing out of `afterPack` as well, or setting `resetAdHocDarwinSignature`, which reseals only the one binary and not the nested Mach-O files under `Contents/Resources`. That is a release-pipeline change and has to be verified on all six shipped artifacts from the four release runners, not on one local `--dir` build. Note that when `electronFuses:` is absent from the config, `doAddElectronFuses()` returns immediately, so electron-builder 26 does nothing to the fuse wire and there is no conflict with the hook.

Path resolution in `afterPack.js` matches electron-builder 26's own `addElectronFuses()`: Linux takes the executable name from the packager (`executableName`), mac and Windows take `appInfo.productFilename`.

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
- Flipping it is not sufficient on its own. The correct hash must also be *computed and injected* into `Info.plist`. electron-builder does automate that part, and did so under 25.1.8 as well: `app-builder-lib`'s `asar/integrity.js` hashes each `.asar` header and `electron/electronMac.js` writes the result to `appPlist.ElectronAsarIntegrity`. Read back out of a 26.15.3 `--dir` build, `Contents/Info.plist` carries `ElectronAsarIntegrity` with a SHA256 header hash for `Resources/app.asar`. So the earlier note here that the injection step was missing was wrong. What has not been established is that the packaged app still launches with the fuse on, given `asarUnpack` and the ad-hoc re-sign in `afterPack.js`, and the next bullet is why getting that wrong is expensive.
- If the fuse is enabled without the matching hash being present/correct, Electron **fails closed**: the app refuses to launch entirely. Given this codebase's release pipeline has no Developer ID signing (see below), shipping a broken launch path was judged a worse outcome than the marginal protection this fuse adds today.
- **Even if wired up correctly, its protection is limited without Developer ID signing.** The hash lives in `Info.plist`, which is itself just a file inside the `.app` bundle — an attacker capable of modifying `app.asar` on disk is equally capable of recomputing the hash and rewriting `Info.plist` to match. macOS bundles *are* code-signed today, but only ad-hoc (`codesign --sign -`, see `scripts/macSign.js`), and an ad-hoc signature requires no identity to produce: after tampering, an attacker simply re-runs `codesign --force --sign - --deep` over the bundle and the result verifies exactly as well as the original did. That is why an ad-hoc signature buys no tamper-evidence. Only a signature an attacker cannot forge — one made with a Developer ID certificate they do not hold — makes the OS's own verification detect *any* modification, including to `Info.plist`. Asar integrity validation is meant to complement code signing, not substitute for it.

**Follow-up (gated on Developer ID signing, see below):** once macOS Developer ID signing is in place, revisit adding `EnableEmbeddedAsarIntegrityValidation` with correct `Info.plist` hash injection in `afterPack.js`, and re-verify the packaged app still launches (per Task 3's boot-test pattern) before shipping it.

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

## Developer ID signing & notarization — NOT done, exact steps to procure

No desktop release build carries a Developer ID or CA-issued signature, and there is no notarization step. Beyond that the posture differs per platform:

- **macOS — ad-hoc signed, not unsigned.** `scripts/macSign.js` runs last in the `afterPack` hook and re-seals the packaged bundle with `codesign --force --sign - --timestamp=none`: first every `.node`/`.dylib` under `Contents/Resources` (which `--deep` does not reach), then `--deep` over the whole `.app`, then a `codesign --verify --deep --strict` so a bad seal fails the build. This exists because packaging *invalidates* the ad-hoc signatures the prebuilt Electron binaries ship with — it renames the executable, rewrites `Info.plist`, injects `app.asar`, and (in the same hook) deletes files under `Contents/Resources`. macOS reports an invalid signature as "Backspace.app is damaged and can't be opened", with no "Open Anyway" affordance anywhere in the UI, so re-sealing is what makes the app openable at all. What the ad-hoc signature gives is a valid bundle seal and nothing more. It does **not** give notarization (first launch still shows the Gatekeeper prompt, cleared via System Settings → Privacy & Security → Open Anyway), it does **not** give a team identifier (so macOS auto-update stays unavailable — see below), and it does **not** give a stable cdhash across releases (so macOS drops Input Monitoring and Screen Recording grants on every update, meaning global keybinds and screen sharing must be re-authorised each time).
- **Windows — unsigned.** No certificate is configured, so installers carry no Authenticode signature and users meet the SmartScreen "Windows protected your PC" prompt.
- **Linux — unsigned.** AppImage and `.deb` artifacts carry no signature, and releases are not served from a GPG-signed apt repository.

`CSC_IDENTITY_AUTO_DISCOVERY: "false"` is set for every platform in the matrix and only stops electron-builder from hunting for an identity in the runner's keychain; it is not what makes the macOS bundle ad-hoc signed. `macSign.js` decides that for itself, from `CSC_LINK`/`CSC_NAME` (see step 5 below).

Procuring real certificates is a real-money, real-identity action outside what can be done in code, so it remains a deliberate, previously-accepted gap — documented here so a maintainer can execute it later without re-deriving the steps.

### macOS: Apple Developer ID + notarization

1. **Procure an Apple Developer Program membership** (~$99/year) at https://developer.apple.com/programs/. Requires a real Apple ID and (for an org) a D-U-N-S number.
2. **Generate a "Developer ID Application" certificate** via Xcode (Settings → Accounts → Manage Certificates → +) or the Apple Developer portal (Certificates → + → Developer ID Application). Export it as a `.p12` file with a password.
3. **Base64-encode the `.p12`** and store it as a GitHub Actions secret (e.g. `MACOS_CERTIFICATE`), plus the export password as `MACOS_CERTIFICATE_PWD`.
4. **Create an App Store Connect API key** (or use an app-specific password) for notarization: App Store Connect → Users and Access → Integrations → App Store Connect API → generate a key with the "Developer" role. Store the key ID, issuer ID, and the `.p8` key content as secrets (e.g. `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`).
5. **In `release.yml`'s macOS job**, replace `CSC_IDENTITY_AUTO_DISCOVERY: "false"` with the real signing identity env vars electron-builder expects (`CSC_LINK` pointing at the decoded `.p12`, `CSC_KEY_PASSWORD`), and add electron-builder's notarization config (`mac.notarize` in `electron-builder.yml`, or the `afterSign` hook pattern electron-builder documents) referencing the App Store Connect API key secrets from step 4. Setting `CSC_LINK` also switches the ad-hoc fallback off: `macSign.js`'s `hasRealSigningIdentity()` returns true as soon as either `CSC_LINK` or `CSC_NAME` is present and returns without touching the bundle, leaving the signing to electron-builder. Note the exact variables — the check is `CSC_LINK || CSC_NAME`; `CSC_KEY_PASSWORD` is not part of it, so a build that exported only the password would still get ad-hoc signed over the top.
6. **Verify** with `codesign --verify --deep --strict` and `spctl -a -vv` against a built `.app`, and `xcrun notarytool history` to confirm the notarization ticket was issued, before shipping to users.

### Windows: code-signing certificate

1. **Procure a code-signing certificate** from a CA in Microsoft's trusted list (e.g. DigiCert, Sectigo) — either an OV certificate (~$300-500/year, subject to a SmartScreen reputation ramp-up) or an EV certificate (~$300-600/year, immediate SmartScreen trust, requires a hardware token or cloud HSM such as Azure Key Vault / SignPath).
2. **Store the certificate** as a GitHub Actions secret. For an EV cert on a hardware token, a cloud HSM signing service (e.g. Azure Trusted Signing, SignPath.io) is the practical path for CI — a physical USB token can't be plugged into a GitHub-hosted runner.
3. **In `release.yml`'s Windows job**, set `CSC_LINK`/`CSC_KEY_PASSWORD` (traditional cert) or wire electron-builder's `win.signtoolOptions`/custom sign hook (HSM-backed signing) per whichever provider is chosen.
4. **Verify** with `signtool verify /pa` against a built `.exe`/NSIS installer before shipping.

### Linux

AppImage/`.deb` distribution does not require a paid certificate; Linux package managers rely on repository-level trust (e.g. a GPG-signed apt repo) rather than binary code signing. If Backspace ever ships via a `.deb` apt repository, GPG-sign the repository metadata — this is a separate, lower-priority item from macOS/Windows signing and is not detailed further here.

### Known gap: auto-update without a verifiable signature

`main.ts`'s `initAutoUpdater()` runs unconditionally on every platform (`electron-updater`'s GitHub provider, configured in `electron-builder.yml`'s `publish:` block; first check 10s after launch, then every 4 hours). What that buys differs per platform:

- **Windows — updates install without a code-signature check**, because there is no signature to check: the app is unsigned, so `electron-updater`'s NSIS path has no publisher name to validate the downloaded installer against. A compromised GitHub release or publishing token could therefore ship a malicious update that installs with nothing to alert the user. (Releases are served over HTTPS, so a plain network MITM is not the concern here.)
- **macOS — auto-update is unavailable, not merely unverified.** There *is* a signature, but it is ad-hoc. `electron-updater` checks and downloads, then hands the update to Electron's native `autoUpdater` (Squirrel.Mac), which will only swap in a bundle whose code signature matches the running app's. An ad-hoc signature carries no team identifier and its cdhash changes with every build, so no new release can ever match — the install step fails and the app stays on the old version. Until Developer ID signing lands, macOS users have to download new releases by hand.
- **Linux — no signature check either.** `electron-updater` selects its AppImage or `.deb` updater from how the app was installed; neither verifies a signature, and the artifacts are unsigned.

Once Developer ID / Authenticode signing (above) is wired up, `electron-updater` will verify the update package's signature before install on Windows, and Squirrel.Mac will be able to validate macOS updates at all. This is flagged as a known gap, not fixed by this plan.

## Not verified

What follows is what has and has not actually been checked, so the sections above are not read as broader assurance than they are.

- **Fuse flipping is verified on macOS arm64 only.** The states were read back out of a packaged macOS arm64 `.app` with the `electron-fuses read` command above. Windows, Linux, and macOS x64 packaged builds have not been checked. This is not a symmetry argument that can be waved through: `flipElectronFuses()` resolves the binary path differently per platform (`.app` / `.exe` / no extension, and `packager.executableName` on Linux versus `appInfo.productFilename` elsewhere), so a wrong path on an unverified platform would surface as a build error or a silently unflipped binary, and nobody has looked.
- **The `will-navigate` deny handler has not been exercised in a packaged build.** Its decision logic is unit-tested directly, at the `isNavigationAllowed()` level, in `packages/desktop/src/navigationPolicy.test.ts`. Nobody has driven a real packaged app into a foreign top-level navigation and watched the handler deny it, so the wiring around that logic — the event registration in `createWindow()`, the `event.preventDefault()`, and `knownInstanceOrigins` actually being populated by the `set-connected-origins` IPC at the moment a navigation is judged — is untested end to end.

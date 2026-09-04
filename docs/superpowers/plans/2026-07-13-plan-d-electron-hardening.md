# Plan D — Desktop/Electron Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the Electron desktop app's packaged-binary security posture — flip the `RunAsNode`, `EnableNodeCliInspectArguments`, and `OnlyLoadAppFromAsar` fuses on every packaged build, add a defensive `will-navigate` deny handler in the main process, and document the current webPreferences/fuses/asar posture plus the exact code-signing and notarization steps a maintainer must complete later — without breaking the existing `afterPack` native-module cleanup, `/join/*` deep-links, cross-instance switching, or the `file://` instance picker.

**Architecture:** Fuses are flipped by calling `@electron/fuses`' `flipFuses()` **inside the existing `scripts/afterPack.js` hook** (electron-builder allows only one `afterPack`, and the installed electron-builder version does not support the top-level `electronFuses:` config key — see Global Constraints for the version evidence). The `will-navigate` deny handler is a defensive, allowlist-based check on the single `mainWindow`'s `webContents`; its decision logic is extracted into a small pure, unit-tested module (`navigationPolicy.ts`) that `main.ts` wires up. A new `docs/systems/desktop-security.md` documents the posture and the signing/notarization steps to procure (document-only — no certs are purchased or faked in this plan).

**Tech Stack:** Electron 40, electron-builder 25.1.8, `@electron/fuses` 1.8.0 (CommonJS, Node ≥ nothing special — see version rationale below), TypeScript strict (desktop package `tsconfig.json`), Vitest.

## Global Constraints

- **Non-breaking, report-only scope.** This plan must not break the existing `afterPack` native-module cleanup (uiohook-napi host-artifact stripping + cross-platform prebuild pruning), `/join/*` deep-links (`setWindowOpenHandler`, `packages/desktop/src/main.ts:454`), cross-instance switching (`loadURL` in the `set-instance-url` IPC handler), or the `file://` instance picker (`loadFile` in `createWindow()` and in `clear-instance-url`). No enforcement flips beyond what's listed here — that is out of scope (a later plan).
- **`setWindowOpenHandler` (`main.ts:454-470`) stays untouched.** The `will-navigate` handler is additive and independent.
- **Signing is DOCUMENT-ONLY.** `docs/systems/desktop-security.md` documents the exact certs to procure and the exact `electron-builder.yml`/`release.yml` changes a maintainer makes once they own those certs. Do not fake a signature, do not add placeholder signing config that silently no-ops.
- **electron-builder allows only ONE `afterPack` hook.** Do not add a second one. All fuse-flipping logic goes inside the existing `scripts/afterPack.js`.
- **Version evidence (do not re-derive — this was verified by direct inspection, not assumption):**
  - `packages/desktop/package.json` declares `"electron-builder": "^25.1.8"`; the installed copy is also `25.1.8` (`node_modules/electron-builder/package.json` and `node_modules/app-builder-lib/package.json` both report `"version": "25.1.8"`).
  - An exhaustive case-insensitive `grep -ril "fuse"` over the entire installed `node_modules/app-builder-lib/` tree (source, `out/`, `scheme.json`) returns **zero hits**. Fetching electron-builder's own upstream `platformPackager.ts` (master branch) shows the `electronFuses:` config key is implemented via `doAddElectronFuses()` / `generateFuseConfig()` / `addElectronFuses()`, none of which exist anywhere in the installed 25.1.8 tree. **Conclusion: the installed electron-builder does not support the `electronFuses:` config key.** Do not add an `electronFuses:` block to `electron-builder.yml` — it would be silently ignored (or, depending on electron-builder's strict-config validation, could hard-fail the build on an unknown key).
  - Therefore: **fuses are flipped via `@electron/fuses`' `flipFuses()` called inside `scripts/afterPack.js`** (the path the spec names as the fallback).
  - **`@electron/fuses` version pin — must be `^1.8.0`, NOT the npm-"latest" `2.x` line.** `npm view @electron/fuses@2.1.3 engines type` reports `{ node: '>=22.12.0' }` and `type: "module"` (ESM-only, no `require()` support) — every `2.x` release (`2.0.0` through `2.1.3`) carries this floor. This repo pins Node 20 everywhere (`package.json` `engines.node: ">=20.0.0"`, `.github/workflows/release.yml` sets `node-version: 20`), so a `2.x` pin would either fail to install cleanly or fail at `require()` time in the CJS `afterPack.js`. `@electron/fuses@1.8.0` has **no `engines` field and no `"type": "module"`** (confirmed via `npm view` + inspecting the published tarball's `dist/index.js`, which is compiled CommonJS) — it is `require()`-able from `scripts/afterPack.js` as-is and has no Node-version conflict. The `flipFuses`/`FuseVersion`/`FuseV1Options`/`resetAdHocDarwinSignature` API is identical between `1.8.0` and `2.x` (verified against `1.8.0`'s published `dist/config.d.ts`) — the `2.x` bump was a runtime-requirement change, not an API break, so pinning `1.8.0` loses nothing needed here.
- **TypeScript strict, no `any`, no placeholder/TODO code.** `packages/desktop/scripts/afterPack.js` is plain CommonJS (loaded via `require()` directly by electron-builder, not compiled by `tsc`) — this matches its existing convention and is not converted to TypeScript in this plan (that would be an unrelated, larger refactor of electron-builder's hook-loading mechanism). `packages/desktop/src/main.ts` and the new `navigationPolicy.ts` are TypeScript strict, no `any`.
- **`will-navigate` mechanism (verified against Electron's docs, not assumed):** `will-navigate` fires only for page/user-initiated top-level navigation (a clicked link, `window.location` assignment, a meta-refresh) — it does **not** fire for main-process-initiated `webContents.loadURL()`/`loadFile()`/`back()`/`forward()` calls. This repo's initial instance load (`main.ts:378,382`), the `file://` picker load (`main.ts:384`), and cross-instance switching (`main.ts:548` inside the `set-instance-url` IPC handler) are **all** main-process `loadURL`/`loadFile` calls, so none of them ever reach a `will-navigate` handler by construction. The handler is still written to explicitly allow same-origin navigation, the picker's `file://` URL, and known federation-peer origins (defense-in-depth, in case future code paths trigger navigation differently) — but this is why adding the deny handler carries no risk to those three flows.
- **Fuse safety check (verified, not assumed):** `grep -rn "ELECTRON_RUN_AS_NODE\|process\.fork(" packages/desktop/src/*.ts` returns no hits — nothing in this codebase re-execs the packaged Electron binary as a plain Node process, so disabling the `RunAsNode` fuse is safe. `uiohook-napi` is a native addon (`dlopen`'d `.node` file), not a forked Node subprocess, so it is unaffected by any of the three fuses.
- **Asar-integrity scope (deliberately narrow — read this before touching `EnableEmbeddedAsarIntegrityValidation`):** the spec's "asar integrity" bullet is a **documentation** requirement, not a 4th fuse to flip. `EnableEmbeddedAsarIntegrityValidation` requires electron-builder (or a manual afterPack step) to compute a SHA-256 hash of the `app.asar` header and inject it into the packaged app's `Info.plist` (macOS) — a mechanism the installed electron-builder 25.1.8 does not automate (confirmed: no fuse-related code in the installed tree) and which, if flipped without correct hash injection, makes Electron **refuse to launch** (fails closed on a hash mismatch). Given (a) it is not in the spec's explicit 3-fuse list, (b) implementing it correctly requires non-trivial custom Info.plist manipulation this plan was not scoped to build and test, and (c) the spec explicitly says "document this honestly, do not over-claim" — this plan flips only the 3 named fuses and documents the asar-integrity posture (why it isn't enabled, what `OnlyLoadAppFromAsar` already gives you, and what unsigned builds mean for any future integrity check) in `docs/systems/desktop-security.md`. Enabling `EnableEmbeddedAsarIntegrityValidation` is out of scope and flagged there as follow-up work gated on real code signing.
- **Local build tooling (for verification steps):** `pnpm --filter @backspace/desktop build` runs `tsc && electron-builder` (no target flags = builds for the host platform, macOS on this machine). `electron-builder --mac --dir` produces an unpacked `.app` (skips DMG/zip) — fast, and still runs the full `afterPack` hook exactly like a real release build. `pnpm --filter @backspace/desktop exec electron-fuses read --app <path>` (once `@electron/fuses` is installed as a devDependency) is the CLI to inspect a packaged binary's fuse states (confirmed: the package's `bin` entry is named `electron-fuses`, not `@electron/fuses`; `npx @electron/fuses` may or may not resolve it depending on npx version — using the local `pnpm exec` binary avoids that ambiguity and avoids a network fetch).
- **Commit identity:** plain `git commit` (repo config = `Jannis Braun <151788261+TheZwiss@users.noreply.github.com>`). Never `-c user.email`, never the `alxtrading94` address.
- **Node 20 / pnpm 10.34.3** are the pinned toolchain.

---

### Task 1: Flip Electron fuses in the existing `afterPack` hook

**Files:**
- Modify: `packages/desktop/package.json` (add `@electron/fuses` devDependency)
- Modify: `packages/desktop/scripts/afterPack.js` (add fuse-flipping, fix an early-return hazard)
- Modify: `packages/desktop/electron-builder.yml` (documentation comment only — no functional change)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: every packaged build (local `--dir`/`--mac`/`--win`/`--linux` and CI's `release.yml`) gets `RunAsNode=false`, `EnableNodeCliInspectArguments=false`, `OnlyLoadAppFromAsar=true` written into the packaged Electron binary. Task 3's live verification consumes this.

- [ ] **Step 1: Add the `@electron/fuses` devDependency**

In `packages/desktop/package.json`, add to `devDependencies` (alphabetically, after `@electron/rebuild`):

```json
    "@electron/fuses": "^1.8.0",
```

So the block reads:

```json
  "devDependencies": {
    "@electron/fuses": "^1.8.0",
    "@electron/rebuild": "^3.7.1",
    "electron": "^40.0.0",
    "electron-builder": "^25.1.8",
    "typescript": "^5.7.2",
    "vitest": "^4.0.18"
  }
```

- [ ] **Step 2: Install and confirm the lockfile is consistent**

Run from the repo root:
```bash
pnpm install
```
Expected: resolves and installs `@electron/fuses@1.8.x` with no `engines`-mismatch warning (unlike a `2.x` pin, which would warn/fail under the Node 20 toolchain). Then confirm the lockfile is reproducible (this is what CI's `release.yml` runs):
```bash
pnpm install --frozen-lockfile
```
Expected: exits 0, no "lockfile is not up to date" error.

- [ ] **Step 3: Restructure `afterPack.js` so the early return can't skip fuse-flipping**

Read `packages/desktop/scripts/afterPack.js` first — the current `exports.default` function has an early `return` (`if (!fs.existsSync(uiohookDir)) { ...; return; }`) if `uiohook-napi` isn't found in the unpacked resources. If fuse-flipping were simply appended after the existing cleanup code, that early return would **silently skip fuse-flipping entirely** on any build where the uiohook check fails — turning off a security control by accident on an edge case, not just skipping the cleanup it was meant to skip. Fix this by making the uiohook cleanup and the fuse-flip two independent phases: the early-return `if` becomes an `if/else` that only gates the cleanup block, and the fuse-flip call sits unconditionally after it.

Replace the full contents of `packages/desktop/scripts/afterPack.js` with:

```js
// afterPack hook for electron-builder
// Two independent jobs run here, in order (electron-builder allows only ONE
// afterPack hook, so both live in this file):
//
// 1. Native module cleanup — removes host-compiled uiohook-napi artifacts so
//    cross-platform builds use the correct prebuilt binaries from
//    `prebuilds/`.
// 2. Electron security fuses — flips RunAsNode/EnableNodeCliInspectArguments/
//    OnlyLoadAppFromAsar on the packaged Electron binary. This runs via
//    `@electron/fuses` directly (NOT electron-builder's `electronFuses:`
//    config key) because the installed electron-builder (25.1.8) predates
//    that feature — see docs/superpowers/plans/2026-07-13-plan-d-electron-
//    hardening.md "Version evidence" for how this was confirmed. Fuse-
//    flipping targets the packaged Electron *binary* (Mach-O/PE/ELF), not
//    the asar contents touched by job 1, so there's no data dependency
//    between the two jobs — but it still runs unconditionally, after the
//    cleanup's early-return branch, so a missing uiohook-napi directory
//    (job 1's skip condition) can never also skip job 2.
//
// Why job 1 is needed:
//   `electron-rebuild` (postinstall) compiles uiohook-napi for the BUILD
//   machine (e.g. macOS arm64), placing the binary in `build/Release/`.
//   `node-gyp-build` checks `build/Release/` BEFORE `prebuilds/{platform}/`,
//   so Windows/Linux packages would load the macOS binary and crash.
//
// What job 1 does:
//   1. Removes `build/`, `build.bak/`, `bin/` dirs (host-compiled artifacts)
//   2. Strips prebuilts for platforms other than the target

const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName; // 'darwin', 'linux', 'win32'
  const appDir = path.join(
    context.appOutDir,
    // macOS bundles resources inside the .app
    platform === 'darwin'
      ? `${context.packager.appInfo.productFilename}.app/Contents/Resources`
      : 'resources'
  );

  const asarUnpacked = path.join(appDir, 'app.asar.unpacked');
  const uiohookDir = path.join(asarUnpacked, 'node_modules', 'uiohook-napi');

  if (!fs.existsSync(uiohookDir)) {
    console.log(`[afterPack] uiohook-napi not found in ${platform} build — skipping native module cleanup`);
  } else {
    // 1. Remove host-compiled artifacts that shadow prebuilts
    for (const dir of ['build', 'build.bak', 'bin']) {
      const target = path.join(uiohookDir, dir);
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true });
        console.log(`[afterPack] Removed ${dir}/ from uiohook-napi (${platform})`);
      }
    }

    // 2. Strip prebuilts for other platforms (saves ~1-2MB per build)
    const prebuildsDir = path.join(uiohookDir, 'prebuilds');
    if (fs.existsSync(prebuildsDir)) {
      for (const entry of fs.readdirSync(prebuildsDir)) {
        const entryPlatform = entry.split('-')[0]; // 'darwin', 'linux', 'win32'
        if (entryPlatform !== platform) {
          fs.rmSync(path.join(prebuildsDir, entry), { recursive: true, force: true });
          console.log(`[afterPack] Stripped prebuilds/${entry} (not needed for ${platform})`);
        }
      }
    }

    console.log(`[afterPack] Native module cleanup done for ${platform}`);
  }

  await flipElectronFuses(context, platform);
};

/**
 * Flips Electron security fuses on the packaged binary:
 *   - RunAsNode: disabled — the app never re-execs itself as a plain Node
 *     process (no `process.fork`/`ELECTRON_RUN_AS_NODE` usage in this
 *     codebase), so disabling this closes off a known Electron sandbox-
 *     escape technique with no functional cost.
 *   - EnableNodeCliInspectArguments: disabled — the packaged app should
 *     never honour `--inspect`/`--inspect-brk`, which would otherwise let a
 *     local attacker attach a debugger to a running instance and execute
 *     arbitrary code in the main process.
 *   - OnlyLoadAppFromAsar: enabled — Electron will only load app code from
 *     `app.asar`, not from a sibling `app`/`app.asar.unpacked/<app-code>`
 *     directory an attacker could plant. This is compatible with the
 *     existing `asarUnpack: **\/*.node` config: that setting only unpacks
 *     native `.node` addons (loaded via Node's own `dlopen`, not Electron's
 *     asar-aware app loader), which OnlyLoadAppFromAsar does not restrict.
 *
 * `EnableEmbeddedAsarIntegrityValidation` is intentionally NOT flipped here
 * — see docs/systems/desktop-security.md for why (it requires a macOS
 * Info.plist hash-injection step this build pipeline doesn't automate, and
 * flipping it without that step makes the app fail closed at launch).
 */
async function flipElectronFuses(context, platform) {
  const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

  const ext = { darwin: '.app', mas: '.app', win32: '.exe', linux: '' }[platform] ?? '';
  // Mirrors electron-builder's own (newer) PlatformPackager#addElectronFuses
  // path resolution: the Linux packager exposes `executableName`; mac/win
  // use `appInfo.productFilename` ("Backspace").
  const executableName =
    typeof context.packager.executableName === 'string'
      ? context.packager.executableName
      : context.packager.appInfo.productFilename;
  const electronBinaryPath = path.join(context.appOutDir, `${executableName}${ext}`);

  await flipFuses(electronBinaryPath, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    // Release builds are unsigned (release.yml sets
    // CSC_IDENTITY_AUTO_DISCOVERY: false — see docs/systems/desktop-
    // security.md), so fuse-flipping is never followed by real code
    // signing. Without this, flipping fuses invalidates the ad-hoc
    // signature Electron/macOS still expects, which can prevent the app
    // from launching at all on Apple Silicon. Harmless no-op on win32/linux.
    resetAdHocDarwinSignature: platform === 'darwin' || platform === 'mas',
  });

  console.log(
    `[afterPack] Electron fuses flipped for ${platform}: RunAsNode=off, EnableNodeCliInspectArguments=off, OnlyLoadAppFromAsar=on`
  );
}
```

- [ ] **Step 4: Add a pointer comment in `electron-builder.yml`**

In `packages/desktop/electron-builder.yml`, the `afterPack` line currently has no comment explaining fuses live there too. Add one directly above it:

```yaml
# afterPack also flips Electron security fuses (RunAsNode, EnableNodeCliInspectArguments,
# OnlyLoadAppFromAsar) via @electron/fuses — NOT via a top-level `electronFuses:` key here,
# because the installed electron-builder (25.1.8) does not support that config key.
# See scripts/afterPack.js and docs/systems/desktop-security.md.
afterPack: ./scripts/afterPack.js
```

(No other line in this file changes — `asarUnpack: **/*.node` at lines 17-18 stays as-is; `OnlyLoadAppFromAsar` is compatible with it, as documented in `afterPack.js` above.)

- [ ] **Step 5: Sanity-check the file loads (syntax only — the real proof is Task 3's packaged build)**

```bash
node -e "require('/Users/jbraun/backspace-public/packages/desktop/scripts/afterPack.js'); console.log('afterPack.js: module loads OK')"
```
Expected: prints `afterPack.js: module loads OK` with no throw. (This only proves the file parses and `exports.default` is a function — it does not execute the packaging logic, which needs a real `context` object electron-builder provides at pack time. Functional proof — the fuses actually landing on a real binary — is Task 3.)

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/package.json pnpm-lock.yaml packages/desktop/scripts/afterPack.js packages/desktop/electron-builder.yml
git commit -m "feat(desktop): flip Electron security fuses in the existing afterPack hook"
```

---

### Task 2: `will-navigate` deny handler (extracted, unit-tested policy + wiring)

**Files:**
- Create: `packages/desktop/src/navigationPolicy.ts`
- Create: `packages/desktop/src/navigationPolicy.test.ts`
- Modify: `packages/desktop/src/main.ts` (add import + wire the handler in `createWindow()`, after the existing `setWindowOpenHandler` block at lines 454-470)

**Interfaces:**
- Consumes: `getPickerPath()` from `./instanceUrl` (existing, `packages/desktop/src/instanceUrl.ts:30-32`); the existing `knownInstanceOrigins: Set<string>` module-level state in `main.ts` (declared `main.ts:70`, populated by the existing `set-connected-origins` IPC handler at `main.ts:534-539`).
- Produces: `isNavigationAllowed(input: NavigationPolicyInput): boolean`, exported from `navigationPolicy.ts`. Task 3 consumes this indirectly (it's wired into `main.ts`, exercised by a real packaged app).

- [ ] **Step 1: Write the failing tests for the pure policy function**

Create `packages/desktop/src/navigationPolicy.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { isNavigationAllowed } from './navigationPolicy';

const PICKER_URL = 'file:///Applications/Backspace.app/Contents/Resources/resources/instance-picker.html';

describe('isNavigationAllowed', () => {
  it('allows same-origin navigation (a normal in-app link/redirect)', () => {
    expect(
      isNavigationAllowed({
        targetUrl: 'https://chat.example.com/channels/123',
        currentUrl: 'https://chat.example.com/app',
        pickerFileUrl: PICKER_URL,
        knownInstanceOrigins: new Set(),
      })
    ).toBe(true);
  });

  it('allows navigation to the bundled file:// instance picker', () => {
    expect(
      isNavigationAllowed({
        targetUrl: PICKER_URL,
        currentUrl: null,
        pickerFileUrl: PICKER_URL,
        knownInstanceOrigins: new Set(),
      })
    ).toBe(true);
  });

  it('denies navigation to a file:// URL that is not the picker', () => {
    expect(
      isNavigationAllowed({
        targetUrl: 'file:///etc/passwd',
        currentUrl: null,
        pickerFileUrl: PICKER_URL,
        knownInstanceOrigins: new Set(),
      })
    ).toBe(false);
  });

  it('allows navigation to a known federation-peer origin', () => {
    expect(
      isNavigationAllowed({
        targetUrl: 'https://peer.example.org/join/abc123',
        currentUrl: 'https://chat.example.com/app',
        pickerFileUrl: PICKER_URL,
        knownInstanceOrigins: new Set(['https://peer.example.org']),
      })
    ).toBe(true);
  });

  it('denies navigation to a foreign http(s) origin not in the known set', () => {
    expect(
      isNavigationAllowed({
        targetUrl: 'https://evil.example.net/phish',
        currentUrl: 'https://chat.example.com/app',
        pickerFileUrl: PICKER_URL,
        knownInstanceOrigins: new Set(['https://peer.example.org']),
      })
    ).toBe(false);
  });

  it('denies a malformed target URL', () => {
    expect(
      isNavigationAllowed({
        targetUrl: 'not a url',
        currentUrl: 'https://chat.example.com/app',
        pickerFileUrl: PICKER_URL,
        knownInstanceOrigins: new Set(),
      })
    ).toBe(false);
  });

  it('denies a non-http(s)/file protocol (e.g. javascript:)', () => {
    expect(
      isNavigationAllowed({
        targetUrl: 'javascript:alert(1)',
        currentUrl: 'https://chat.example.com/app',
        pickerFileUrl: PICKER_URL,
        knownInstanceOrigins: new Set(),
      })
    ).toBe(false);
  });

  it('denies a foreign origin even when currentUrl is null/unknown', () => {
    expect(
      isNavigationAllowed({
        targetUrl: 'https://evil.example.net/phish',
        currentUrl: null,
        pickerFileUrl: PICKER_URL,
        knownInstanceOrigins: new Set(),
      })
    ).toBe(false);
  });

  it('denies when currentUrl is malformed and target is not otherwise allowlisted', () => {
    expect(
      isNavigationAllowed({
        targetUrl: 'https://chat.example.com/app',
        currentUrl: 'not a url',
        pickerFileUrl: PICKER_URL,
        knownInstanceOrigins: new Set(),
      })
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail (module doesn't exist yet)**

```bash
pnpm --filter @backspace/desktop exec vitest run navigationPolicy.test.ts
```
Expected: FAIL — `Cannot find module './navigationPolicy'` (or equivalent resolve error).

- [ ] **Step 3: Implement `navigationPolicy.ts`**

Create `packages/desktop/src/navigationPolicy.ts`:

```typescript
// Pure decision logic for the `will-navigate` deny handler wired up in
// main.ts's createWindow(). Extracted so it can be unit-tested without
// booting Electron; main.ts owns the wiring (webContents.on('will-navigate',
// ...) + event.preventDefault()), this module owns the policy (which
// top-level navigations are allowed).
//
// `will-navigate` fires only for page/user-initiated top-level navigation
// (a clicked link, `window.location` assignment, a meta-refresh) — never for
// main-process `webContents.loadURL()`/`loadFile()` calls. That means the
// app's own initial instance load, the file:// picker load, and
// cross-instance switching (all done via loadURL/loadFile in main.ts) never
// reach this policy. It still explicitly allows same-origin navigation, the
// bundled picker, and known federation-peer origins — defense-in-depth
// against a compromised or malicious renderer trying to hijack the
// top-level frame — rather than denying unconditionally.

export interface NavigationPolicyInput {
  /** The navigation target, exactly as received from the `will-navigate` event. */
  targetUrl: string;
  /** The window's current top-level URL (webContents.getURL()), or null if unavailable/unparseable. */
  currentUrl: string | null;
  /** file:// URL of the bundled instance picker (pathToFileURL(getPickerPath()).href). */
  pickerFileUrl: string;
  /** Federation peer + own-instance origins the renderer has reported as connected (main.ts's knownInstanceOrigins). */
  knownInstanceOrigins: ReadonlySet<string>;
}

export function isNavigationAllowed(input: NavigationPolicyInput): boolean {
  const { targetUrl, currentUrl, pickerFileUrl, knownInstanceOrigins } = input;

  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return false;
  }

  if (target.protocol === 'file:') {
    return target.href === pickerFileUrl;
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return false;
  }

  let currentOrigin: string | null = null;
  if (currentUrl !== null) {
    try {
      currentOrigin = new URL(currentUrl).origin;
    } catch {
      currentOrigin = null;
    }
  }

  return target.origin === currentOrigin || knownInstanceOrigins.has(target.origin);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @backspace/desktop exec vitest run navigationPolicy.test.ts
```
Expected: PASS — all 9 tests green.

- [ ] **Step 5: Wire the handler into `main.ts`**

In `packages/desktop/src/main.ts`, add the import alongside the existing `path`/`fs`/`os` imports (near line 14-16):

```typescript
import { pathToFileURL } from 'url';
```

And add to the `instanceUrl` import block's neighbours — add a new import line right after the existing `import { migrateUserData } from './userDataMigration';` (line 40):

```typescript
import { isNavigationAllowed } from './navigationPolicy';
```

Then, in `createWindow()`, immediately after the existing `setWindowOpenHandler` block closes (after line 470's closing `});`, before the function's own closing `}` on line 471), add:

```typescript
  // Deny foreign top-level navigations. See navigationPolicy.ts for the
  // mechanism note on why this is safe for the initial instance load, the
  // file:// picker, and cross-instance switching (none of them are
  // `will-navigate` events). setWindowOpenHandler above is unaffected — this
  // only covers same-window top-level navigation, not new-window/tab opens.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = isNavigationAllowed({
      targetUrl: url,
      currentUrl: mainWindow?.webContents.getURL() ?? null,
      pickerFileUrl: pathToFileURL(getPickerPath()).href,
      knownInstanceOrigins,
    });
    if (!allowed) {
      console.warn(`[main] Blocked will-navigate to disallowed target: ${url}`);
      event.preventDefault();
    }
  });
```

- [ ] **Step 6: Typecheck**

```bash
pnpm --filter @backspace/desktop exec tsc
```
Expected: exits 0, no errors (strict mode, no `any`).

- [ ] **Step 7: Run the full desktop test suite**

```bash
pnpm --filter @backspace/desktop test
```
Expected: all existing suites (`recovery.test.ts`, `autoLaunch.test.ts`, `userDataMigration.test.ts`) plus the new `navigationPolicy.test.ts` pass.

- [ ] **Step 8: Manual smoke check in dev mode (fast — doesn't need a packaged build)**

`will-navigate` firing doesn't depend on packaging or fuses, so this can be checked directly in the unpacked dev app:

```bash
pnpm --filter @backspace/desktop dev
```

With the app running and connected to an instance (or on the picker screen):
1. Open DevTools on the main window (View → Toggle Developer Tools, or the standard Electron shortcut) and in the Console run:
   ```js
   window.location.href = 'https://example.com/';
   ```
   Expected: the window's URL does NOT change to `example.com`; the console shows the `[main] Blocked will-navigate to disallowed target: https://example.com/` warning in the **terminal running `pnpm --filter @backspace/desktop dev`** (main-process logs, not the renderer console).

   > Note: this dev-mode smoke step runs `electron .`, which transitively loads the native `uiohook-napi` addon. On a box where `postinstall`'s `electron-rebuild` was skipped for lack of build tooling, `electron .` may crash at require-time before the handler can be exercised. That is an environment limitation, not a defect — **Task 3's packaged build (Step 6) is the authoritative proof** of the `will-navigate` handler. If dev-mode won't boot here, rely on Task 3.
2. Confirm the app still works normally afterward: the instance picker still loads (if you started with no saved instance), and connecting to a real instance still loads it (loadURL is a main-process call, unaffected by the new handler).
3. Quit the app (`Cmd+Q` / tray → Quit) — no need to leave it running.

- [ ] **Step 9: Commit**

```bash
git add packages/desktop/src/navigationPolicy.ts packages/desktop/src/navigationPolicy.test.ts packages/desktop/src/main.ts
git commit -m "feat(desktop): add will-navigate deny handler for foreign top-level navigations"
```

---

### Task 3: Live verification — packaged build with fuses + will-navigate together

**Files:** none (verification-only task; no source changes).

**Interfaces:**
- Consumes: Task 1's fuse-flipping in `afterPack.js` and Task 2's `will-navigate` handler.
- Produces: a real packaged `.app` used as evidence; no code artifacts for later tasks.

This is the task the plan's constraints call out explicitly: build the real desktop app, boot the packaged binary (not `pnpm dev`), and confirm the fuses are actually flipped, the existing native-module cleanup still ran, and `will-navigate` blocks a foreign URL — in the same artifact CI would ship.

- [ ] **Step 1: Build an unpacked macOS app (fast — skips DMG/zip codesigning/notarization steps)**

```bash
cd /Users/jbraun/backspace-public
pnpm --filter @backspace/shared build
cd packages/desktop
pnpm exec tsc
pnpm exec electron-builder --mac --dir
```
Expected: builds successfully; watch the output for the two `[afterPack]` log lines this plan added:
```
[afterPack] Native module cleanup done for darwin
[afterPack] Electron fuses flipped for darwin: RunAsNode=off, EnableNodeCliInspectArguments=off, OnlyLoadAppFromAsar=on
```
If the "Native module cleanup" line is missing or says "skipping", STOP — Task 1's restructuring broke the existing cleanup path; do not proceed. If the "Electron fuses flipped" line is missing entirely, STOP — the fuse-flip did not run.

- [ ] **Step 2: Locate the packaged app and confirm the native-module cleanup artifacts are actually gone**

```bash
APP_PATH=$(find /Users/jbraun/backspace-public/packages/desktop/dist-electron -maxdepth 2 -iname "Backspace.app" | head -1)
echo "App: $APP_PATH"
ls "$APP_PATH/Contents/Resources/app.asar.unpacked/node_modules/uiohook-napi/" 2>/dev/null
```
Expected: `$APP_PATH` resolves to a real path; the `uiohook-napi` directory listing shows `prebuilds/` (darwin-only, other platforms' prebuilds stripped) and does **not** show a `build/` or `bin/` directory (those are the host-compiled artifacts Task 1's cleanup removes) — confirming the existing cleanup behavior is intact after the restructuring.

- [ ] **Step 3: Read the fuse states back off the packaged binary**

```bash
cd /Users/jbraun/backspace-public/packages/desktop
pnpm exec electron-fuses read --app "$APP_PATH"
```
Expected output shows (exact wording may vary slightly by `@electron/fuses` version, but the three states must match):
```
RunAsNode is Disabled
...
EnableNodeCliInspectArguments is Disabled
...
OnlyLoadAppFromAsar is Enabled
```
If any of the three is `Inherited` (i.e., not set) or shows the opposite state, STOP — the fuse-flip in `afterPack.js` did not apply correctly; do not proceed to declare Task 1/2 done.

- [ ] **Step 4: Boot the packaged app and confirm it launches (asar/fuse posture doesn't break startup)**

```bash
open "$APP_PATH"
sleep 3
ps aux | grep -i "[B]ackspace" | head -5
```
Expected: the process list shows the Backspace app running (`resetAdHocDarwinSignature: true` in Task 1 prevents the fuse-flip from producing a signature mismatch that would otherwise make macOS refuse to launch it). If the app fails to launch or macOS shows a "damaged app" / Gatekeeper dialog, STOP — this indicates the ad-hoc signature handling needs revisiting; do not mark Task 1 done.

- [ ] **Step 5: Confirm the instance picker (file:// load) still works**

With the app open (no saved instance from a previous run — if one exists, use "Disconnect"/"Switch instance" from the app UI, or delete `~/Library/Application Support/Backspace/instance-url.json` and relaunch via `open "$APP_PATH"`), visually confirm the instance picker screen loads and its "Connect" flow accepts a URL. This exercises the exact `loadFile()` path the `will-navigate` handler's allowlist was written for.

- [ ] **Step 6: Confirm a foreign top-level navigation is blocked in the packaged app**

With the app connected to any reachable Backspace instance (a local dev server works: `pnpm dev` from the repo root in a separate terminal, then use the picker to connect to `http://localhost:5173` or your configured dev URL), open DevTools in the packaged app (same shortcut as Task 2 Step 8) and run in the console:
```js
window.location.href = 'https://example.com/';
```
Then check the packaged app's main-process log. Since a packaged app's stdout isn't attached to a terminal by default, launch it from the terminal instead to see the log:
```bash
"$APP_PATH/Contents/MacOS/Backspace"
```
(Ctrl+C to stop this run when done; repeat the DevTools navigation attempt against this terminal-launched instance.) Expected: the window's URL does not change, and the terminal prints `[main] Blocked will-navigate to disallowed target: https://example.com/`.

- [ ] **Step 7: Confirm `/join/*` deep-link routing is unaffected**

`setWindowOpenHandler` (untouched by this plan) is exercised by `window.open()`/target=`_blank` calls, not `will-navigate` — confirm by inspecting the code path only (no live network join needed): re-read `main.ts:454-470` and confirm it is byte-for-byte unchanged from before this plan (`git diff main` on `main.ts` should show only the new `will-navigate` block added after it, no lines removed/changed inside `setWindowOpenHandler`):
```bash
cd /Users/jbraun/backspace-public
git diff main -- packages/desktop/src/main.ts | grep -A3 -B3 "setWindowOpenHandler"
```
Expected: no `-` (removed) lines inside the `setWindowOpenHandler` block; only additions after it.

- [ ] **Step 8: Clean up**

```bash
pkill -f "dist-electron.*Backspace" 2>/dev/null || true
rm -rf /Users/jbraun/backspace-public/packages/desktop/dist-electron
```

- [ ] **Step 9: Record what could NOT be verified on this machine**

Note honestly (in the PR description / final report, not as a code change) that this Mac can only exercise the **macOS/arm64, unsigned** build path. The following are NOT verified here and are maintainer follow-up (via a real `release.yml` run on a tag, or manual `workflow_dispatch`):
- Windows (`.exe`, NSIS) and Linux (AppImage/deb) fuse-flipping and `will-navigate` behavior — the `afterPack.js` logic is platform-branched (`ext` map, `executableName` resolution) but only the `darwin` branch was exercised here.
- Real code-signed/notarized behavior (this plan is document-only for signing — see Task 4).
- `resetAdHocDarwinSignature`'s effect on an Intel (`x64`) mac build, vs. this arm64 machine.

No commit for this task (verification-only).

---

### Task 4: `docs/systems/desktop-security.md` — new subsystem doc

**Files:**
- Create: `docs/systems/desktop-security.md`

**Interfaces:**
- Consumes: the posture established by Tasks 1-2 and the version/mechanism evidence gathered in this plan's Global Constraints.
- Produces: the doc CLAUDE.md's subsystem table (Task 5) points to.

- [ ] **Step 1: Write the doc**

Create `docs/systems/desktop-security.md`:

```markdown
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
```

- [ ] **Step 2: Verify the doc reflects reality**

```bash
grep -q "OnlyLoadAppFromAsar" docs/systems/desktop-security.md && \
grep -q "EnableEmbeddedAsarIntegrityValidation" docs/systems/desktop-security.md && \
grep -q "CSC_IDENTITY_AUTO_DISCOVERY" docs/systems/desktop-security.md && \
grep -q "will-navigate" docs/systems/desktop-security.md && \
echo "doc covers fuses, asar-integrity honesty, signing gap, and will-navigate"
```
Expected: `doc covers fuses, asar-integrity honesty, signing gap, and will-navigate`.

- [ ] **Step 3: Commit**

```bash
git add docs/systems/desktop-security.md
git commit -m "docs(desktop): document Electron fuses, asar-integrity posture, and signing/notarization steps"
```

---

### Task 5: CLAUDE.md subsystem table row + final consistency pass

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `docs/systems/desktop-security.md` from Task 4.
- Produces: nothing consumed downstream — final task.

- [ ] **Step 1: Add the subsystem-table row**

In `CLAUDE.md`, the subsystem table has a row for `desktop.md` immediately followed by `mobile-ui.md`. Insert a new row for `desktop-security.md` directly after the `desktop.md` row:

```markdown
| [desktop-security.md](docs/systems/desktop-security.md) | Electron webPreferences posture, security fuses (RunAsNode/EnableNodeCliInspectArguments/OnlyLoadAppFromAsar), asar-integrity posture and its unsigned-build limits, `will-navigate` top-level navigation policy, code-signing/notarization procurement steps | Electron hardening work, fuses, navigation security, desktop code-signing |
```

- [ ] **Step 2: Verify the row was added correctly**

```bash
grep -n "desktop-security.md" CLAUDE.md
```
Expected: one match, a table row between the `desktop.md` and `mobile-ui.md` rows.

- [ ] **Step 3: Final full-repo consistency check**

Run the full verification sweep one more time from the repo root, now that all of Plan D's changes are in place together:
```bash
cd /Users/jbraun/backspace-public
pnpm install --frozen-lockfile
pnpm --filter @backspace/shared build
pnpm --filter @backspace/desktop exec tsc
pnpm --filter @backspace/desktop test
```
Expected: all four commands exit 0. This confirms Task 1's dependency addition, Task 2's new module + wiring, and the overall desktop package are consistent together (not just individually, at each task's own commit point).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): add desktop-security.md to the subsystem table"
```

---

## Self-Review Notes

- **Spec coverage:** fuses (RunAsNode off, EnableNodeCliInspectArguments off, OnlyLoadAppFromAsar on) via `flipFuses()` inside the existing single `afterPack.js` hook (Task 1) ✓; version-gated decision between `electronFuses:` key and the afterPack fallback, with concrete evidence (Global Constraints + Task 1) ✓; `@electron/fuses` added as a devDependency, with the Node-20/CJS-compatible version actually verified rather than assumed (Task 1) ✓; asar-integrity interaction with `asarUnpack`/afterPack mutations noted, and the "don't over-claim" instruction honored by scoping `EnableEmbeddedAsarIntegrityValidation` out and documenting why (Global Constraints + Task 4) ✓; `will-navigate` deny handler allowing initial load/picker/cross-instance-switch, `setWindowOpenHandler` left untouched (Task 2) ✓; `docs/systems/desktop-security.md` covering webPreferences, fuses/asar posture and limits, and exact signing/notarization steps + unsigned-autoupdate gap (Task 4) ✓; `@electron/fuses` dependency addition (Task 1) ✓; CLAUDE.md subsystem row (Task 5) ✓.
- **Non-breaking, by construction:** the `afterPack.js` restructuring in Task 1 was specifically designed around a real hazard found during research (the existing early-`return` would have silently skipped fuse-flipping too) rather than a naive append. The `will-navigate` handler's safety for the three existing navigation flows rests on documented Electron event semantics (verified against the mechanism, not assumed) plus an explicit allowlist as a second line of defense. `setWindowOpenHandler` has zero lines touched (Task 3 Step 7 asserts this via `git diff`).
- **Live verification, not just unit tests:** Task 3 is a dedicated task that builds a real `.app`, reads its fuse states with the actual `@electron/fuses` CLI, boots it, and exercises the picker + a blocked foreign navigation — plus records exactly what can't be checked on this machine (non-macOS platforms, signed/notarized behavior) as maintainer follow-up, rather than silently ignoring it.
- **Adversarial pre-write checks folded in:** confirmed via `grep` that nothing in this codebase uses `process.fork`/`ELECTRON_RUN_AS_NODE` (so `RunAsNode: false` is safe); confirmed the exact `@electron/fuses` version compatible with this repo's Node 20 pin by inspecting real `npm view` output and a downloaded tarball, not by trusting the "latest" tag; confirmed electron-builder's actual installed fuse (non-)support by grepping the real installed package rather than trusting the spec's assumption; confirmed the CLI binary name (`electron-fuses`, not `@electron/fuses`) by reading the published package's `bin` field.

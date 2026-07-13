// afterPack hook for electron-builder
//
// Three jobs run here, in this order (electron-builder allows only ONE
// afterPack hook, so all three live in this file):
//
//   1. Native module cleanup — removes host-compiled uiohook-napi artifacts so
//      cross-platform builds use the correct prebuilt binaries from the
//      `prebuilds/` directory.
//   2. Electron security fuses — flips RunAsNode/EnableNodeCliInspectArguments/
//      OnlyLoadAppFromAsar on the packaged Electron binary. This runs via
//      `@electron/fuses` directly (NOT electron-builder's `electronFuses:`
//      config key) because the installed electron-builder (25.1.8) predates
//      that feature — see docs/systems/desktop-security.md for how this was
//      confirmed and when to migrate to the config key.
//   3. On macOS, ad-hoc sign the bundle (see macSign.js).
//
// Order matters, and it is load-bearing in both directions:
//   - Signing seals the bundle's contents, so it must run after every file
//     mutation — both the cleanup's deletions (job 1) and the fuse flip's
//     rewrite of the Electron binary (job 2). Flipping fuses after signing
//     would invalidate the signature and leave a "damaged" bundle.
//   - Because signing now happens *after* the flip, `@electron/fuses`'
//     `resetAdHocDarwinSignature` option is deliberately NOT used: macSign.js
//     re-seals the whole bundle (including the nested Mach-O files under
//     Contents/Resources), which is a strictly stronger seal than the fuse
//     library's darwin-only ad-hoc reset of the single Electron binary.
//
// afterPack is also the only hook available for the signing step —
// electron-builder skips the `afterSign` hook entirely when no signing
// occurred, which is exactly the case this build is in.
//
// Why job 1 is needed:
//   `electron-rebuild` (postinstall) compiles uiohook-napi for the BUILD
//   machine (e.g. macOS arm64), placing the binary in `build/Release/`.
//   `node-gyp-build` checks `build/Release/` BEFORE `prebuilds/{platform}/`,
//   so Windows/Linux packages would load the macOS binary and crash.

const fs = require('fs');
const path = require('path');

const { signMacAppIfUnsigned } = require('./macSign');

/**
 * Strips host-compiled artifacts and foreign-platform prebuilts from the
 * packaged copy of uiohook-napi.
 *
 * @param {string} appDir Resources directory of the packaged app.
 * @param {string} platform electron-builder platform name.
 * @returns {void}
 */
function cleanNativeModules(appDir, platform) {
  const asarUnpacked = path.join(appDir, 'app.asar.unpacked');
  const uiohookDir = path.join(asarUnpacked, 'node_modules', 'uiohook-napi');

  if (!fs.existsSync(uiohookDir)) {
    console.log(`[afterPack] uiohook-napi not found in ${platform} build — skipping cleanup`);
    return;
  }

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
 * `resetAdHocDarwinSignature` is intentionally NOT set. Flipping fuses does
 * invalidate the ad-hoc signature the prebuilt Electron binary ships with,
 * but the caller runs macSign.js immediately afterwards, and that re-seals
 * the entire bundle rather than just the one binary. Enabling the option
 * here would be a weaker, redundant seal on darwin and a no-op elsewhere.
 *
 * `EnableEmbeddedAsarIntegrityValidation` is intentionally NOT flipped here
 * — see docs/systems/desktop-security.md for why (it requires a macOS
 * Info.plist hash-injection step this build pipeline doesn't automate, and
 * flipping it without that step makes the app fail closed at launch).
 *
 * @param {object} context electron-builder afterPack hook context.
 * @param {string} platform electron-builder platform name.
 * @returns {Promise<void>}
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
  });

  console.log(
    `[afterPack] Electron fuses flipped for ${platform}: RunAsNode=off, EnableNodeCliInspectArguments=off, OnlyLoadAppFromAsar=on`
  );
}

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName; // 'darwin', 'linux', 'win32'
  const isMac = platform === 'darwin';
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appDir = path.join(
    context.appOutDir,
    // macOS bundles resources inside the .app
    isMac ? `${appName}/Contents/Resources` : 'resources'
  );

  cleanNativeModules(appDir, platform);

  await flipElectronFuses(context, platform);

  // Must stay last: signing seals the bundle, and both steps above mutate it.
  if (isMac) {
    signMacAppIfUnsigned(path.join(context.appOutDir, appName));
  }
};

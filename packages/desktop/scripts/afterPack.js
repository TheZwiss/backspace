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

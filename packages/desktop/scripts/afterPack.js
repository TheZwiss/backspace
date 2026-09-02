// afterPack hook for electron-builder
//
// Two jobs, in order:
//   1. Remove host-compiled native module artifacts so cross-platform builds
//      use the correct prebuilt binaries from the `prebuilds/` directory.
//   2. On macOS, ad-hoc sign the bundle (see macSign.js).
//
// Order matters: signing seals the bundle's contents, so it must run after
// every file mutation. afterPack is also the only hook available for this —
// electron-builder skips the `afterSign` hook entirely when no signing
// occurred, which is exactly the case this build is in.
//
// Why the native module cleanup is needed:
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

  if (isMac) {
    signMacAppIfUnsigned(path.join(context.appOutDir, appName));
  }
};

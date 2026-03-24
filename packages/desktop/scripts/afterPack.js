// afterPack hook for electron-builder
// Removes host-compiled native module artifacts so cross-platform builds
// use the correct prebuilt binaries from the `prebuilds/` directory.
//
// Why this is needed:
//   `electron-rebuild` (postinstall) compiles uiohook-napi for the BUILD
//   machine (e.g. macOS arm64), placing the binary in `build/Release/`.
//   `node-gyp-build` checks `build/Release/` BEFORE `prebuilds/{platform}/`,
//   so Windows/Linux packages would load the macOS binary and crash.
//
// What this does:
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
    console.log(`[afterPack] uiohook-napi not found in ${platform} build — skipping`);
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
};
